/**
 * app.js — 管理界面主模块：登录、路由、五个 tab 视图、任务操作、账号向导、设置与触发器试算。
 * 纯前端静态资源，无构建步骤，无 CDN 依赖，无 mock 数据。
 */

import {
  api,
  setUnauthorizedHandler,
  el,
  frag,
  icon,
  iconButton,
  toast,
  closeModal,
  openModal,
  confirmDialog,
  withLoading,
  setServerNow,
  serverNow,
  formatClock,
  formatDateTime,
  formatFullTime,
  formatRelative,
  formatCountdown,
  toMillis,
  describeSchedule,
  describeSteps,
  stepSummary,
  targetLabel,
  peerKindLabel,
  emptyState,
  field,
} from "./lib.js";
import { openTaskEditor } from "./editor.js";

const VIEWS = ["overview", "tasks", "logs", "account", "settings"];

const state = {
  session: null,
  build: null, // 构建信息（/api/version），用于排查线上版本
  data: null,
  view: "overview",
  logs: null, // 日志 tab 拉取的列表；概览用 state.data.logs（最新 50）
  logsTotal: null, // 当前筛选条件下的总条数
  logPage: 1,
  logPageSize: 20,
  logPages: 1,
  turnstileToken: "", // Turnstile 通过后拿到的 token（登录时提交）
  turnstileWidget: null, // widget id，用于 reset
  turnstileSiteKey: null,
  logLevel: "", // "" | "ok" | "fail"
  logTaskId: "", // "" = 全部任务
  logQuery: "", // 关键字搜索
  expandedLogs: new Set(),
  refreshing: false,
  accountStep: 1,
  accountHint: "",
  accountPhone: "",
  testText: "",
  parse: null,
};

const dom = {};

/* --------------------------------------------------------------- 启动 */

function cacheDom() {
  dom.boot = document.getElementById("boot");
  dom.login = document.getElementById("login-view");
  dom.loginForm = document.getElementById("login-form");
  dom.loginPassword = document.getElementById("login-password");
  dom.loginSubmit = document.getElementById("login-submit");
  dom.loginError = document.getElementById("login-error");
  dom.loginBuild = document.getElementById("login-build");
  dom.turnstileSlot = document.getElementById("turnstile-slot");
  dom.footerVersion = document.getElementById("footer-version");
  dom.loginSetup = document.getElementById("login-setup");
  dom.app = document.getElementById("app-view");
  dom.tabs = document.getElementById("tabs");
  dom.viewRoot = document.getElementById("view-root");
  dom.accountChip = document.getElementById("account-chip");
  dom.clock = document.getElementById("clock");
  dom.logoutBtn = document.getElementById("logout-btn");
  dom.overlay = document.getElementById("overlay");
}

async function init() {
  cacheDom();
  loadBuildInfo();

  setUnauthorizedHandler(() => {
    const needsSetup = Boolean(state.session && state.session.needsSetup);
    state.session = { authenticated: false, needsSetup };
    state.data = null;
    state.logs = null;
    state.accountStep = 1;
    state.accountHint = "";
    closeModal(true);
    showLogin({ message: "登录状态已失效，请重新登录", needsSetup });
  });

  dom.loginForm.addEventListener("submit", onLoginSubmit);
  dom.logoutBtn.addEventListener("click", onLogout);
  dom.accountChip.addEventListener("click", () => {
    location.hash = "#/account";
  });
  window.addEventListener("hashchange", route);

  setInterval(tick, 1000);
  setInterval(pollState, 30000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.data) refreshState({ silent: true });
  });

  state.view = viewFromHash();

  try {
    const session = await api("/api/session");
    state.session = session || { authenticated: false, needsSetup: false };
  } catch (error) {
    showLogin({ message: error.message || "无法连接服务端" });
    return;
  }

  if (!state.session.authenticated) {
    showLogin({ needsSetup: Boolean(state.session.needsSetup) });
    return;
  }

  await enterApp();
  if (state.build && dom.footerVersion) dom.footerVersion.textContent = `版本 ${formatBuild(state.build)}`;
}

/**
 * 拉一次构建信息。部署排查时最有用的一句话就是「线上是哪一版」，
 * 所以登录页和设置页都会显示它。
 */
async function loadBuildInfo() {
  try {
    const info = await fetch("/api/version", { headers: { accept: "application/json" } }).then((res) =>
      res.ok ? res.json() : null,
    );
    if (!info) return;
    state.build = info;
    const text = formatBuild(info);
    if (dom.loginBuild) {
      dom.loginBuild.textContent = `版本 ${text}`;
      dom.loginBuild.hidden = false;
    }
    if (dom.footerVersion) dom.footerVersion.textContent = `版本 ${text}`;
    paintBuildInfo();
  } catch {
    /* 版本信息拿不到不影响使用 */
  }
}

/** 版本号（package.json）· commit（构建时的 HEAD）· 构建时间（UTC） */
function formatBuild(info) {
  if (!info) return "未知";
  const parts = [];
  if (info.version) parts.push(`v${info.version}`);
  if (info.commit) parts.push(info.commit);
  if (info.buildId && info.buildId !== "dev") {
    parts.push(String(info.buildId).replace("T", " ").replace("Z", " UTC"));
  }
  return parts.length ? parts.join(" · ") : "dev";
}

function paintBuildInfo() {
  const target = document.getElementById("about-build");
  if (!target || !state.build) return;
  target.textContent = formatBuild(state.build);
}

function showBoot() {
  if (dom.boot) dom.boot.hidden = false;
  if (dom.login) dom.login.hidden = true;
  if (dom.app) dom.app.hidden = true;
}

/** 人机验证没通过时不允许点登录（服务端也会拒，这里是体验上的即时反馈） */
function setLoginEnabled(enabled) {
  if (!dom.loginSubmit) return;
  dom.loginSubmit.disabled = !enabled;
  dom.loginSubmit.setAttribute("aria-disabled", String(!enabled));
}

/** 当前是否需要人机验证（配置了 site key 就需要） */
function needsTurnstile() {
  return Boolean(state.turnstileSiteKey || (state.session && state.session.turnstileSiteKey));
}

/**
 * 按需加载 Cloudflare Turnstile。
 * 只有服务端配了 TURNSTILE_SITE_KEY 才会渲染（/api/session 会带下来），
 * 没配的话登录页和以前一样，不需要人机验证。
 */
async function setupTurnstile() {
  const slot = dom.turnstileSlot;
  if (!slot) return;

  // 设置页刚配好 / 刚登出时，本地可能还没有 site key —— 现拉一次 /api/session
  let siteKey = state.turnstileSiteKey || (state.session && state.session.turnstileSiteKey) || null;
  if (!siteKey) {
    try {
      const latest = await api("/api/session", { auth: false });
      if (latest) {
        state.session = { ...(state.session || {}), ...latest };
        siteKey = latest.turnstileSiteKey || null;
      }
    } catch {
      /* 拿不到就当没启用 */
    }
  }
  if (!siteKey) {
    // 没启用人机验证 → 按钮保持可用
    state.turnstileSiteKey = null;
    setLoginEnabled(true);
    return;
  }
  state.turnstileSiteKey = siteKey;

  // 已经渲染过：按当前 token 恢复按钮状态
  if (state.turnstileWidget !== null) {
    setLoginEnabled(Boolean(state.turnstileToken));
    return;
  }

  slot.hidden = false;
  slot.textContent = "正在加载人机验证…";
  setLoginEnabled(false);

  try {
    if (!window.turnstile) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error("Turnstile 脚本加载失败"));
        document.head.appendChild(script);
      });
    }
    if (!window.turnstile) throw new Error("Turnstile 不可用");
    slot.textContent = "";
    state.turnstileWidget = window.turnstile.render(slot, {
      sitekey: siteKey,
      theme: "dark",
      callback: (token) => {
        state.turnstileToken = token;
        setLoginEnabled(true);
      },
      "expired-callback": () => {
        state.turnstileToken = "";
        setLoginEnabled(false);
      },
      "error-callback": () => {
        state.turnstileToken = "";
        setLoginEnabled(false);
        setLoginError("人机验证加载失败，请刷新重试");
        return true;
      },
    });
  } catch (error) {
    slot.textContent = "";
    setLoginEnabled(false);
    setLoginError(error.message || "人机验证加载失败");
  }
}

/** 登录失败后重置挂件，避免复用过期 token */
function resetTurnstile() {
  state.turnstileToken = "";
  if (state.turnstileSiteKey) setLoginEnabled(false);
  if (state.turnstileWidget !== null && window.turnstile) {
    try {
      window.turnstile.reset(state.turnstileWidget);
    } catch {
      /* ignore */
    }
  }
}

function showLogin({ message = "", needsSetup = false } = {}) {
  if (dom.boot) dom.boot.hidden = true;
  if (dom.app) dom.app.hidden = true;
  dom.login.hidden = false;
  dom.loginSetup.hidden = !needsSetup;
  setLoginError(message);
  setLoginEnabled(!needsTurnstile());
  void setupTurnstile();
  setTimeout(() => dom.loginPassword && dom.loginPassword.focus(), 30);
}

function setLoginError(message) {
  dom.loginError.textContent = message || "";
  dom.loginError.hidden = !message;
}

async function enterApp() {
  showBoot();
  const ok = await refreshState({ silent: true });
  if (!ok) {
    // 401 已由全局回调处理；其他错误停在登录页并给出提示
    if (!state.session || !state.session.authenticated) return;
    showLogin({ message: "读取状态失败，请刷新页面重试" });
    return;
  }
  dom.boot.hidden = true;
  dom.login.hidden = true;
  dom.app.hidden = false;
  state.view = viewFromHash();
  paint({ force: true });
  tick();
  void migrateLocalTemplates();
}

async function onLoginSubmit(event) {
  event.preventDefault();
  setLoginError("");
  const password = dom.loginPassword.value;
  if (!password) {
    setLoginError("请输入管理密码");
    dom.loginPassword.focus();
    return;
  }
  if (needsTurnstile() && !state.turnstileToken) {
    setLoginError("请先完成人机验证");
    return;
  }
  let failed = false;
  await withLoading(dom.loginSubmit, async () => {
    try {
      const payload = { password };
      if (state.turnstileSiteKey) {
        // widget 回调可能还没触发，直接从隐藏 input 兜底取
        payload.turnstileToken =
          state.turnstileToken ||
          (document.querySelector('input[name="cf-turnstile-response"]') || {}).value ||
          "";
      }
      await api("/api/login", { method: "POST", body: payload, auth: false });
      dom.loginPassword.value = "";
      state.session = { authenticated: true, needsSetup: false };
      state.logs = null;
      toast("登录成功", { kind: "ok" });
      await enterApp();
  if (state.build && dom.footerVersion) dom.footerVersion.textContent = `版本 ${formatBuild(state.build)}`;
    } catch (error) {
      failed = true;
      setLoginError(error.message || "登录失败");
      dom.loginPassword.focus();
      dom.loginPassword.select();
    }
  });

  // 放在 withLoading 之后：它会把 disabled 恢复成"进入时的值"，
  // 在里面改按钮状态会被覆盖（aria 和 disabled 不一致）
  if (failed) {
    resetTurnstile();
    setLoginEnabled(false);
  }
}

async function onLogout() {
  const confirmed = await confirmDialog({
    title: "退出管理界面？",
    message: "退出后需要重新输入管理口令才能进来。签到任务照常按计划执行，不受影响。",
    confirmLabel: "退出登录",
  });
  if (!confirmed) return;

  await withLoading(dom.logoutBtn, async () => {
    try {
      await api("/api/logout", { method: "POST", auth: false });
    } catch (error) {
      if (error.status !== 401) {
        toast(error.message, { kind: "error" });
        return;
      }
    }
    state.session = { authenticated: false, needsSetup: false };
    state.data = null;
    state.logs = null;
    state.accountStep = 1;
    state.testText = "";
    state.parse = null;
    closeModal(true);
    showLogin({});
    toast("已退出登录", { kind: "ok" });
  });
}

/* ------------------------------------------------------------ 状态管理 */

async function refreshState({ silent = false } = {}) {
  if (state.refreshing) return false;
  state.refreshing = true;
  try {
    const data = await api("/api/state");
    state.data = data || {};
    serverTemplates = Array.isArray(data?.settings?.templates)
      ? data.settings.templates.filter((item) => item && item.command)
      : serverTemplates;
    setServerNow(data && data.now);
    updateChrome();
    paint();
    tick();
    if (state.view === "logs") loadLogs({ silent: true });
    return true;
  } catch (error) {
    if (error.status === 401) return false;
    if (!silent) toast(error.message || "读取状态失败", { kind: "error" });
    return false;
  } finally {
    state.refreshing = false;
  }
}

function pollState() {
  if (!state.data || document.hidden) return;
  if (state.view === "settings") return; // 避免覆盖正在编辑的表单
  if (dom.overlay && !dom.overlay.hidden) return;
  refreshState({ silent: true });
}

function viewFromHash() {
  const raw = String(location.hash || "").replace(/^#\/?/, "").split("?")[0];
  return VIEWS.includes(raw) ? raw : "overview";
}

function route() {
  const view = viewFromHash();
  state.view = view;
  if (!state.data) return;
  if (view === "logs") loadLogs({ silent: true });
  paint({ force: true });
}

function paint({ force = false } = {}) {
  if (!state.data || !dom.viewRoot || dom.app.hidden) return;
  const active = document.activeElement;
  if (!force && active instanceof HTMLElement && dom.viewRoot.contains(active)) {
    const tag = active.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return; // 别打断输入
  }
  updateTabs();
  dom.viewRoot.replaceChildren(renderView());
}

function updateTabs() {
  if (!dom.tabs) return;
  for (const link of dom.tabs.querySelectorAll(".tab")) {
    const active = link.dataset.view === state.view;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function updateChrome() {
  const account = (state.data && state.data.account) || {};
  if (dom.accountChip) {
    dom.accountChip.replaceChildren();
    const dot = account.signedIn ? (account.connected ? "ok" : "warn") : "fail";
    dom.accountChip.append(
      el("span", { class: `dot ${dot}` }),
      el("span", {}, accountLabel(account)),
    );
    dom.accountChip.title = account.signedIn
      ? "查看 Telegram 账号"
      : "还没有登录 Telegram，点击前往账号页";
  }
  if (dom.clock) dom.clock.textContent = formatClock();
}

function accountLabel(account) {
  if (!account || !account.signedIn || !account.me) return "未登录 Telegram";
  const name = account.me.firstName || account.me.username || account.me.id;
  return account.me.username ? `${name} @${account.me.username}` : String(name);
}

/** 每秒刷新时钟与相对时间/倒计时（不重建 DOM）。 */
function tick() {
  if (dom.clock && !dom.app.hidden) dom.clock.textContent = formatClock();
  const now = serverNow();
  for (const node of document.querySelectorAll("[data-countdown]")) {
    const at = Number(node.dataset.countdown);
    if (!at) continue;
    node.textContent = formatCountdown(at - now);
    node.classList.toggle("is-past", at <= now);
  }
  for (const node of document.querySelectorAll("[data-relative]")) {
    const at = Number(node.dataset.relative);
    if (!at) continue;
    node.textContent = formatRelative(at, now);
  }
}

/* ------------------------------------------------------------- 渲染入口 */

function renderView() {
  switch (state.view) {
    case "tasks":
      return renderTasks();
    case "logs":
      return renderLogs();
    case "account":
      return renderAccount();
    case "settings":
      return renderSettings();
    default:
      return renderOverview();
  }
}

/* --------------------------------------------------------------- 概览 */

/** 概览顶部的「快速开始」：三步走完自动消失 */
function quickStartCard() {
  const data = state.data || {};
  const account = data.account || {};
  const settings = data.settings || {};
  const tasks = data.tasks || [];
  const logs = data.logs || [];
  const hasRun = logs.some((log) => log.ok && isExecutionLog(log));
  const example = `${settings.triggerPrefix || "tg"} 9.30 签到`;

  const steps = [
    {
      done: Boolean(account.signedIn),
      title: "登录 Telegram 账号",
      desc: "填应用 ID / 密钥和手机号，收验证码即可",
      action: { label: "去登录", href: "#/account" },
    },
    {
      done: tasks.length > 0,
      title: "创建第一个任务",
      desc: "在收藏夹发一条指令，或用「新建任务」表单",
      action: { label: "去任务页", href: "#/tasks" },
    },
    {
      done: hasRun,
      title: "执行一次试试",
      desc: `例如在收藏夹发「${example}」`,
      action: { label: "复制示例", copy: example },
    },
  ];

  const doneCount = steps.filter((step) => step.done).length;
  if (doneCount === steps.length) return null;

  return card({
    title: "快速开始",
    description: `${doneCount} / ${steps.length} 步完成，全部完成后这条会自动收起。`,
    body: el(
      "ol",
      { class: "quickstart" },
      steps.map((step, index) =>
        el(
          "li",
          { class: `quickstart-step${step.done ? " is-done" : ""}` },
          el("span", { class: "quickstart-index" }, step.done ? icon("check", { size: 12 }) : String(index + 1)),
          el(
            "div",
            { class: "quickstart-body" },
            el("div", { class: "quickstart-title" }, step.title),
            el("div", { class: "quickstart-desc" }, step.desc),
          ),
          step.action.href
            ? el("a", { class: "btn btn-sm", href: step.action.href }, step.action.label)
            : el(
                "button",
                {
                  class: "btn btn-sm",
                  type: "button",
                  onclick: () => copyText(step.action.copy, "已复制，去收藏夹粘贴发送即可"),
                },
                step.action.label,
              ),
        ),
      ),
    ),
  });
}

function renderOverview() {
  const data = state.data || {};
  const account = data.account || {};
  const settings = data.settings || {};
  const stats = data.stats || {};
  const logs = Array.isArray(data.logs) ? data.logs.slice(0, 5) : [];
  const nextRunAt = toMillis(stats.nextRunAt) || null;
  const lastRunAt = toMillis(stats.lastRunAt);
  const nextRunHint = nextRunAt ? formatDateTime(nextRunAt) : "新建任务后自动排期";

  const header = pageHead({
    title: "概览",
    description: "任务、调度与 Telegram 连接的一览。",
    actions: [
      btn("执行全部", { iconName: "bolt", onClick: (event) => runAll(event.currentTarget) }),
      btn("立即检查", {
        variant: "subtle",
        iconName: "refresh",
        onClick: (event) => runTick(event.currentTarget),
      }),
    ],
  });

  const runtime = (state.data && state.data.runtime) || {};
  const grid = el(
    "div",
    { class: "stat-grid" },
    statCard({
      label: "Telegram 连接",
      dot: account.signedIn ? "ok" : "fail",
      value: account.signedIn
        ? `已登录${account.me && account.me.firstName ? ` · ${account.me.firstName}` : ""}`
        : "未登录",
      foot: account.signedIn
        ? `上次通信 ${
            account.lastConnectedAt ? formatRelative(account.lastConnectedAt) : "还没连过"
          } · 定时任务照常执行`
        : el("a", { class: "link", href: "#/account" }, "现在登录 Telegram"),
      sub: account.signedIn ? "空闲是正常状态，需要时才建立连接" : null,
    }),
    statCard({
      label: "任务",
      value: el(
        "span",
        { class: "num" },
        `${Number(stats.enabledTasks) || 0} / ${Number(stats.totalTasks) || 0}`,
      ),
      foot: lastRunAt
        ? el(
            "span",
            {},
            "上次执行 ",
            el(
              "span",
              { class: "num", dataset: { relative: String(lastRunAt) } },
              formatRelative(lastRunAt),
            ),
          )
        : "还没有执行记录",
    }),
    statCard({
      label: "下一次执行",
      value: nextRunAt
        ? el("span", { class: "num", dataset: { countdown: String(nextRunAt) } }, formatCountdown(nextRunAt - serverNow()))
        : "暂无排期",
      foot: nextRunAt
        ? el("span", { class: "num", title: formatFullTime(nextRunAt) }, nextRunHint)
        : nextRunHint,
    }),
    statCard({
      label: "消息指令",
      dot: settings.triggerEnabled ? "ok" : "idle",
      value: settings.triggerEnabled ? "运行中" : "已关闭",
      foot: `来源 ${controlChatLabel(settings)} · 每 ${Number(settings.pollSeconds) || 60} 秒检查一次${
        runtime && runtime.nextPollAt ? `（下次 ${formatClock(runtime.nextPollAt)}）` : ""
      }`,
      sub:
        runtime && runtime.lastPollAt
          ? `上次检查 ${formatRelative(runtime.lastPollAt)}` +
            (Date.now() - runtime.lastPollAt > Math.max(180_000, (Number(settings.pollSeconds) || 60) * 3000)
              ? " ⚠️ 已超时"
              : "")
          : "登录 Telegram 后开始自动检查",
      sub2:
        runtime && runtime.lastTriggerEvent
          ? `最近事件：${runtime.lastTriggerEvent.ok ? "" : "⚠️ "}${runtime.lastTriggerEvent.message}（${formatRelative(
              runtime.lastTriggerEvent.at,
            )}）`
          : "最近事件：还没处理过消息指令",
      sub: `按钮检测 ${Number(settings.stepPollSeconds) || 3}s / 上限 ${Number(settings.stepWaitSeconds) || 30}s`,
    }),
  );

  const recentCard = card({
    title: "最近活动",
    className: "log-card",
    actions: [el("a", { class: "link link-sm", href: "#/logs" }, "查看全部")],
    body: logs.length
      ? el("ul", { class: "log-list" }, logs.map(logItem))
      : el(
          "div",
          { class: "empty empty-inline" },
          el("span", { class: "empty-icon" }, icon("list", { size: 18 })),
          el("p", { class: "empty-title" }, "还没有执行记录"),
          el("p", { class: "empty-text" }, "手动运行一次，或在收藏夹里发条指令试试。"),
        ),
  });

  return frag(
    header,
    account.lastError ? banner("warn", account.lastError) : null,
    quickStartCard(),
    grid,
    el(
      "div",
      { class: "overview-cols" },
      recentCard,
      el(
        "aside",
        { class: "card hint-card" },
        el("span", { class: "hint-icon" }, icon("terminal", { size: 18 })),
        el(
          "div",
          { class: "hint-body" },
          el("h2", { class: "card-title" }, "消息指令"),
          el(
            "p",
            { class: "hint-line" },
            `在${controlChatLabel(settings)}发 `,
            el("code", { class: "code" }, "9.30 签到"),
            " 就能建任务",
          ),
          el(
            "p",
            { class: "hint-sub" },
            settings.triggerEnabled
              ? "会自动读取新消息，支持点击按钮、随机文本、成功关键词等写法。"
              : "消息指令已关闭，可在设置里重新开启。",
          ),
          el("a", { class: "link link-sm", href: "#/settings" }, "看看怎么写指令", icon("arrowRight", { size: 14 })),
        ),
      ),
    ),
  );
}

function statCard({ label, dot, value, foot, sub, sub2 }) {
  return el(
    "section",
    { class: "card stat" },
    el("div", { class: "stat-label" }, label),
    el("div", { class: "stat-value" }, dot ? el("span", { class: `dot ${dot}` }) : null, value),
    foot ? el("div", { class: "stat-foot" }, foot) : null,
    sub ? el("div", { class: "stat-foot stat-sub" }, sub) : null,
    sub2 ? el("div", { class: "stat-foot stat-sub stat-muted" }, sub2) : null,
  );
}

/* --------------------------------------------------------------- 任务 */

function renderTasks() {
  const tasks = Array.isArray(state.data.tasks) ? state.data.tasks : [];
  const enabled = tasks.filter((task) => task.enabled).length;

  const newTaskBtn = (variant = "primary", label = "新建任务") =>
    btn(label, { variant, iconName: "plus", onClick: () => openEditor(null) });
  const newBtn = newTaskBtn();

  // 检出重复任务（同目标 + 同调度 + 同动作）：它们会同时触发，看起来像"连发好几次"
  const buckets = new Map();
  for (const task of tasks) {
    const key = [
      task.target && (task.target.username || task.target.id),
      JSON.stringify(task.schedule || {}),
      JSON.stringify(task.steps || []),
    ].join("|");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(task);
  }
  const duplicates = [...buckets.values()].filter((group) => group.length > 1);

  const header = pageHead({
    title: "任务",
    description: tasks.length
      ? `${tasks.length} 个任务 · ${enabled} 个启用 · ${tasks.length - enabled} 个停用 · 「立即执行」只是手动跑一次，不影响定时`
      : "还没有任务，先建一个。",
    actions: [
      btn("导入", { variant: "subtle", iconName: "download", onClick: () => openImportDialog() }),
      ...(tasks.length
        ? [
            btn("导出", { variant: "subtle", iconName: "upload", onClick: () => withLoading(null, () => exportTasks()) }),
            btn("执行全部", { iconName: "bolt", onClick: (event) => runAll(event.currentTarget) }),
          ]
        : []),
      newBtn,
    ],
  });

  if (!tasks.length) {
    return frag(
      header,
      el(
        "div",
        { class: "card card-pad" },
        emptyState({
          iconName: "list",
          title: "还没有任务",
          text: "可以从模板开始，也可以手动新建，或直接在收藏夹发一条指令让它自己建。",
          actions: [
            newTaskBtn("ghost", "新建任务"),
            el("a", { class: "btn btn-subtle", href: "#/settings" }, "看看指令怎么写"),
          ],
        }),
        templateChips(),
      ),
    );
  }

  return frag(
    header,
    duplicates.length
      ? el(
          "div",
          { class: "banner banner-warn" },
          el(
            "div",
            { class: "banner-text" },
            el("strong", {}, `有 ${duplicates.length} 组任务的设置一模一样`),
            el(
              "p",
              {},
              duplicates
                .map((group) => `#${group.map((task) => task.id).join(" / #")}`)
                .join("；") + " 会同时触发、重复发送，建议只保留一个。",
            ),
          ),
        )
      : null,
    (() => {
      const groups = taskGroupList(tasks);
      // 选中的分组没了（任务被改/删）→ 回到「全部」
      const stored = activeTaskGroup();
      const activeKey = groups.items.some((item) => item.key === stored) ? stored : "";
      const visible = tasksInGroup(tasks, activeKey);
      const rail = taskGroupRail(groups, activeKey);
      const table = el("div", { class: "card table-card" }, el("div", { class: "table-wrap" },
        visible.length
          ? taskTable(visible)
          : emptyState({
              iconName: "list",
              title: "这个分组还没有任务",
              text: "在编辑器里给任务填上分组名，它就会出现在这里。",
              actions: [newTaskBtn("primary", "新建任务")],
            }),
      ));

      if (!rail) return table;

      return el(
        "div",
        { class: "tasks-layout" },
        rail,
        el("div", { class: "tasks-main" }, table),
      );
    })(),
  );
}

const TASK_GROUP_KEY = "cf-tg.taskGroup.active";

/** 侧栏里的分组项：全部 / 各分组 / 未分组 */
function taskGroupList(tasks) {
  const named = new Map();
  let ungrouped = 0;
  for (const task of tasks) {
    const name = (task.group || "").trim();
    if (name) named.set(name, (named.get(name) || 0) + 1);
    else ungrouped += 1;
  }
  return {
    hasGroups: named.size > 0,
    items: [
      { key: "", label: "全部", count: tasks.length },
      ...[...named.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], "zh"))
        .map(([name, count]) => ({ key: name, label: name, count })),
      ...(ungrouped ? [{ key: "__ungrouped", label: "未分组", count: ungrouped }] : []),
    ],
  };
}

function activeTaskGroup() {
  try {
    return localStorage.getItem(TASK_GROUP_KEY) || "";
  } catch {
    return "";
  }
}

function setActiveTaskGroup(key) {
  try {
    if (key) localStorage.setItem(TASK_GROUP_KEY, key);
    else localStorage.removeItem(TASK_GROUP_KEY);
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 当前分组下的任务（未分组的任务归到「未分组」） */
function tasksInGroup(tasks, key) {
  if (!key) return tasks;
  if (key === "__ungrouped") return tasks.filter((task) => !(task.group || "").trim());
  return tasks.filter((task) => (task.group || "").trim() === key);
}

/** 任务行的通用点击行为（点空白处打开详情） */
function taskRowClickable(task) {
  const row = taskRow(task);
  row.classList.add("is-clickable");
  row.addEventListener("click", (event) => {
    if (isInteractiveClick(event)) return;
    void openTaskDetail(task);
  });
  return row;
}

/** 左侧分组栏（没有分组时不渲染，保持原来的单栏布局） */
function taskGroupRail(groups, activeKey) {
  if (!groups.hasGroups) return null;
  return el(
    "aside",
    { class: "group-rail", "aria-label": "任务分组" },
    el(
      "div",
      { class: "group-rail-title" },
      "分组",
    ),
    ...groups.items.map((item) =>
      el(
        "button",
        {
          class: `group-rail-item${activeKey === item.key ? " is-active" : ""}`,
          type: "button",
          "aria-pressed": String(activeKey === item.key),
          onclick: () => {
            setActiveTaskGroup(item.key);
            paint({ force: true });
          },
        },
        el("span", { class: "group-rail-name cell-trunc" }, item.label),
        el("span", { class: "group-rail-count num" }, String(item.count)),
      ),
    ),
  );
}

function taskTable(tasks) {
  return el(
    "table",
    { class: "table tasks-table" },
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", {}, "任务"),
        el("th", {}, "目标"),
        el("th", {}, "调度"),
        el("th", {}, "动作"),
        el("th", {}, "下次执行"),
        el("th", {}, "最近结果"),
        el("th", { class: "th-actions" }, "操作"),
      ),
    ),
    el(
      "tbody",
      {},
      tasks.map((task) => taskRowClickable(task)),
    ),
  );
}

/**
 * 点击是否落在「行内的可交互元素」上（按钮 / 链接 / 输入框 / 带 data-no-row-click 的容器）。
 *
 * 注意目标可能是 SVG 元素（图标按钮里点到的是 <path>），它**不是** HTMLElement，
 * 所以这里必须用 Element 判断 —— 之前用 HTMLElement 导致点图标按钮也会弹出任务详情。
 */
function isInteractiveClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("button, a, input, select, textarea, label, [data-no-row-click]"));
}

function taskRow(task) {
  const target = task.target || {};
  const enabledText = task.enabled ? "已启用" : "已停用";
  const subParts = [`#${task.id}`];
  if (task.source === "trigger") subParts.push("由指令创建");
  if (task.threadId) subParts.push(`话题 ${task.threadId}`);

  const nextRunAt = toMillis(task.nextRunAt);
  const nextCell = task.enabled
    ? nextRunAt
      ? el(
          "span",
          { class: "num", title: formatFullTime(nextRunAt) },
          el(
            "span",
            { dataset: { countdown: String(nextRunAt) } },
            formatCountdown(nextRunAt - serverNow()),
          ),
        )
      : el("span", { class: "muted" }, "—")
    : el("span", { class: "muted" }, "已停用");

  return el(
    "tr",
    { class: task.enabled ? "" : "is-disabled", dataset: { id: String(task.id) } },
    el(
      "td",
      { dataset: { label: "任务" } },
      el(
        "div",
        { class: "cell-main" },
        el("span", { class: `dot ${task.enabled ? "ok" : "idle"}`, title: enabledText }),
        el("span", { class: "task-name cell-text" }, task.name || `任务 #${task.id}`),
        task.source === "trigger" ? el("span", { class: "tag" }, "指令创建") : null,
      ),
      el("div", { class: "cell-sub" }, subParts.join(" · ")),
    ),
    el(
      "td",
      { dataset: { label: "目标" } },
      el(
        "div",
        { class: "cell-main", title: targetLabel(target) },
        peerKindLabel(target.peerKind)
          ? el("span", { class: `tag tag-peer is-${target.peerKind}` }, peerKindLabel(target.peerKind))
          : null,
        el("span", { class: "cell-text" }, targetLabel(target)),
        task.targets && task.targets.length > 1 ? el("span", { class: "tag" }, `+${task.targets.length - 1}`) : null,
      ),
      el(
        "div",
        { class: "cell-sub" },
        // 主行已经显示了 @username 时就别再重复，退回显示数字 id
        target.username && targetLabel(target) !== `@${target.username}`
          ? `@${target.username}`
          : target.id
            ? String(target.id)
            : "—",
      ),
    ),
    el("td", { dataset: { label: "调度" } }, el("span", { class: "cell-nowrap" }, describeSchedule(task.schedule))),
    el(
      "td",
      { dataset: { label: "动作" } },
      el("span", { class: "cell-trunc cell-steps", title: describeSteps(task.steps) }, describeSteps(task.steps)),
    ),
    el("td", { dataset: { label: "下次执行" } }, nextCell),
    el("td", { dataset: { label: "最近结果" } }, resultCell(task)),
    el(
      "td",
      { dataset: { label: "操作" }, class: "cell-actions" },
      el(
        "div",
        { class: "row-actions", "data-no-row-click": "" },
        iconButton("play", "立即执行", (event) => runTask(task, event.currentTarget)),
        iconButton("power", task.enabled ? "停用" : "启用", (event) => toggleTask(task, event.currentTarget), {
          className: task.enabled ? "is-on" : "",
        }),
        iconButton("pencil", "编辑", () => openEditor(task)),
        iconButton("trash", "删除", () => deleteTask(task), { className: "is-danger" }),
      ),
    ),
  );
}

function resultCell(task) {
  if (!task.lastResult) {
    return el(
      "button",
      {
        class: "link link-sm result-detail-btn muted",
        type: "button",
        onclick: () => openTaskDetail(task),
      },
      "详情",
    );
  }
  const ok = task.lastResult === "ok";
  return el(
    "div",
    { class: "result-cell" },
    el(
      "span",
      {
        class: `status ${ok ? "is-ok" : "is-fail"}`,
        title:
          (task.lastMessage || "") +
          (Number(task.failStreak) > 0 ? `（已连续失败 ${task.failStreak} 次）` : ""),
      },
      el("span", { class: `dot ${ok ? "ok" : "fail"}` }),
      el("span", {}, ok ? "成功" : "失败"),
    ),
    el(
      "button",
      {
        class: "link link-sm result-detail-btn",
        type: "button",
        onclick: () => openTaskDetail(task),
      },
      "详情",
    ),
  );
}

/** 任务详情弹窗：状态 + 最近运行 + 快捷操作，替代原来分散在三处的信息 */
async function openTaskDetail(task) {
  const settings = (state.data && state.data.settings) || {};
  const timezone = Number(settings.timezone ?? 8);
  const runsBox = el("div", { class: "task-runs" }, el("div", { class: "hint" }, "正在读取最近运行…"));

  const modal = openModal({
    title: `任务详情 · ${task.name || `#${task.id}`}`,
    body: el(
      "div",
      { class: "task-detail" },
      el(
        "div",
        { class: "task-detail-head" },
        el(
          "span",
          { class: `status ${task.enabled ? "is-ok" : "is-idle"}` },
          el("span", { class: `dot ${task.enabled ? "ok" : "idle"}` }),
          el("span", {}, task.enabled ? "已启用" : "已停用"),
        ),
        task.lastResult
          ? el(
              "span",
              { class: `status ${task.lastResult === "ok" ? "is-ok" : "is-fail"}` },
              el("span", { class: `dot ${task.lastResult === "ok" ? "ok" : "fail"}` }),
              el("span", {}, task.lastResult === "ok" ? "上次成功" : "上次失败"),
            )
          : null,
      ),
      el(
        "div",
        { class: "kv-list" },
        kv(
          "目标类型",
          peerKindLabel(task.target.peerKind) || "未知（下次执行时自动识别）",
        ),
        kv(
          "目标",
          task.targets && task.targets.length > 1
            ? el(
                "span",
                {},
                task.targets.map((item) => (item.username ? `@${item.username}` : item.title || item.id)).join(" · "),
              )
            : targetLabel(task.target),
        ),
        kv("执行时间", describeSchedule(task.schedule, timezone)),
        kv("下次执行", task.nextRunAt ? formatDateTime(task.nextRunAt) : "—"),
        kv("动作", describeSteps(task.steps)),
        task.successKeywords && task.successKeywords.length
          ? kv("成功关键词", task.successKeywords.join(" / "))
          : null,
      ),
      el("div", { class: "form-section-title" }, "最近运行"),
      runsBox,
    ),
    footer: el(
      "div",
      { class: "dialog-actions" },
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: async (event) => {
            await withLoading(event.currentTarget, async () => {
              try {
                const res = await api(`/api/tasks/${encodeURIComponent(task.id)}/command`);
                await copyText(res.command, "指令已复制，可粘到收藏夹重建这个任务");
              } catch (error) {
                toast(error.message || "生成指令失败", { kind: "error" });
              }
            });
          },
        },
        "复制指令",
      ),
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => {
            closeModal();
            location.hash = "#/logs";
            state.logTaskId = String(task.id);
            void reloadLogsFromFirstPage();
          },
        },
        "查看全部日志",
      ),
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => {
            closeModal();
            openEditor(task);
          },
        },
        "编辑",
      ),
      el(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          onclick: async (event) => {
            await withLoading(event.currentTarget, async () => {
              try {
                const res = await api(`/api/tasks/${encodeURIComponent(task.id)}/run`, { method: "POST" });
                toast(res.ok ? "执行成功" : "执行失败", { kind: res.ok ? "ok" : "error" });
                await renderTaskRuns(task, runsBox);
                await refreshState({ silent: true });
                paint({ force: true });
              } catch (error) {
                toast(error.message || "执行失败", { kind: "error" });
              }
            });
          },
        },
        "立即执行",
      ),
    ),
  });

  // 详情内容偏宽（键值表 + 运行列表），给弹窗加个宽度修饰类（幂等）
  if (modal && modal.dialog && !modal.dialog.classList.contains("dialog-wide")) {
    modal.dialog.classList.add("dialog-wide");
  }

  await renderTaskRuns(task, runsBox);
}

async function renderTaskRuns(task, box) {
  box.textContent = "";
  try {
    const res = await api(`/api/tasks/${encodeURIComponent(task.id)}/logs?limit=12`);
    const all = Array.isArray(res && res.logs) ? res.logs : [];
    // 只看真正的执行记录（跳过"跳过重复任务"这类系统日志）
    const runs = all.filter(isExecutionLog).slice(0, 5);
    if (!runs.length) {
      box.append(el("div", { class: "hint" }, "这个任务还没运行过。点右下角「立即执行」试一次。"));
      return;
    }
    box.append(
      el(
        "ul",
        { class: "task-run-list" },
        runs.map((run) =>
          el(
            "li",
            { class: "task-run" },
            el(
              "div",
              { class: "task-run-head" },
              el("span", { class: `dot ${run.ok ? "ok" : run.level === "warn" ? "warn" : "fail"}` }),
              el("span", { class: "task-run-msg" }, run.message || "（无消息）"),
              el("span", { class: "task-run-time num", title: formatFullTime(toMillis(run.at)) }, formatRelative(toMillis(run.at))),
            ),
            run.detail ? el("pre", { class: "task-run-detail" }, String(run.detail)) : null,
          ),
        ),
      ),
    );
  } catch (error) {
    box.append(el("div", { class: "hint" }, error.message || "读取失败"));
  }
}



/**
 * 常用模板：直接写成指令文本，由 /api/trigger/parse 解析后填进编辑器。
 * 这样模板和指令语法永远一致（改了语法模板自动跟着变）。
 */
const TASK_TEMPLATES = [
  {
    id: "daily",
    name: "每日打卡",
    desc: "每天到点发一句「签到」，用关键词判定成功",
    command: "9.00 签到 #kw:签到成功",
  },
  {
    id: "menu",
    name: "两级菜单签到",
    desc: "/start → 点「个人资料」→ 点「签到」",
    command: "9.00 /start btn:个人资料 btn:签到 #kw:签到成功",
  },
  {
    id: "random",
    name: "每日随机问候",
    desc: "在时间窗口里随机挑一句发出去",
    command: "8.30-10.00 rand:早上好|午安|晚上好",
  },
  {
    id: "reminder",
    name: "群里定时提醒",
    desc: "每天固定时间发一段固定内容",
    command: "9.00 该打卡啦 #keep",
  },
];

// editor.js 里要展示同一份模板，这里挂到 window 上避免循环 import
window.__taskGroups = () =>
  [...new Set(((state.data && state.data.tasks) || []).map((task) => (task.group || "").trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b, "zh"),
  );
window.__openEditorTemplate = (template) => void openTemplate(template);
window.__openEditorTemplates = () => [
  ...TASK_TEMPLATES,
  ...loadCustomTemplates().map((item) => ({ ...item, custom: true })),
];
window.__removeTemplate = removeTemplate;
window.__saveTemplateFromCommand = saveTemplateFromCommand;

async function openTemplate(template) {
  const settings = (state.data && state.data.settings) || {};
  const prefix = (settings.triggerPrefix || "").trim();
  const text = prefix ? `${prefix} ${template.command}` : template.command;
  try {
    const parsed = await api("/api/trigger/parse", { method: "POST", body: { text } });
    if (!parsed || parsed.ok === false) {
      toast(parsed?.error || "模板解析失败", { kind: "error" });
      return;
    }
    void api("/api/events", { method: "POST", body: { name: "template_used" } }).catch(() => undefined);
    const draft = {
      ...parsed.task,
      id: 0,
      name: template.name,
      target: { kind: "user", id: "" },
    };
    openTaskEditor({
      task: draft,
      defaultTarget: settings.defaultTarget || "",
      onSaved: async () => {
        await refreshState({ silent: true });
        paint({ force: true });
      },
    });
  } catch (error) {
    toast(error.message || "模板解析失败", { kind: "error" });
  }
}

const CUSTOM_TEMPLATES_KEY = "cf-tg.customTemplates";

/** 自定义模板存服务端设置里（跨设备同步）；localStorage 只用于首次迁移旧数据 */
let serverTemplates = null;

function loadCustomTemplates() {
  if (serverTemplates) return serverTemplates;
  const fromServer = state.data && state.data.settings && state.data.settings.templates;
  if (Array.isArray(fromServer)) {
    serverTemplates = fromServer.filter((item) => item && item.command);
    return serverTemplates;
  }
  return [];
}

/** 老版本把模板存在浏览器里，登录后一次性搬到服务端 */
async function migrateLocalTemplates() {
  if (serverTemplates && serverTemplates.length) return;
  let legacy = [];
  try {
    legacy = JSON.parse(localStorage.getItem(CUSTOM_TEMPLATES_KEY) || "[]");
  } catch {
    legacy = [];
  }
  if (!Array.isArray(legacy) || !legacy.length) return;
  try {
    await api("/api/settings", {
      method: "POST",
      body: { templates: legacy.filter((item) => item && item.command) },
    });
    localStorage.removeItem(CUSTOM_TEMPLATES_KEY);
    serverTemplates = null;
    await refreshState({ silent: true });
  } catch {
    /* 迁移失败不影响使用 */
  }
}

async function persistTemplates(list) {
  const res = await api("/api/settings", { method: "POST", body: { templates: list.slice(0, 20) } });
  serverTemplates = (res.settings && res.settings.templates) || list.slice(0, 20);
  if (state.data && state.data.settings) state.data.settings.templates = serverTemplates;
}

/** 把当前编辑器里的配置存成模板（服务端，跨设备） */
async function saveTemplateFromCommand(name, command) {
  const trimmed = String(command || "").trim();
  if (!trimmed) {
    toast("先生成一个等价指令，再存为模板", { kind: "error" });
    return;
  }
  const list = [...loadCustomTemplates()];
  const label = String(name || "我的模板").trim().slice(0, 20) || "我的模板";
  if (list.some((item) => item.command === trimmed)) {
    toast("已经有一样的模板了", { kind: "info" });
    return;
  }
  list.unshift({ id: `t${Date.now()}`, name: label, command: trimmed });
  try {
    await persistTemplates(list);
    toast(`已存为模板「${label}」`, { kind: "ok" });
    paint({ force: true });
  } catch (error) {
    toast(error.message || "保存模板失败", { kind: "error" });
  }
}

async function removeTemplate(id) {
  try {
    await persistTemplates(loadCustomTemplates().filter((item) => item.id !== id));
    paint({ force: true });
  } catch (error) {
    toast(error.message || "删除模板失败", { kind: "error" });
  }
}

/** 模板区：内置 + 自定义（自定义可删除） */
function templateChips({ onSaved } = {}) {
  const custom = loadCustomTemplates();
  return el(
    "div",
    { class: "template-chips" },
    el("span", { class: "template-label" }, "从模板开始"),
    ...TASK_TEMPLATES.map((template) =>
      el(
        "button",
        {
          class: "chip chip-button",
          type: "button",
          title: template.desc,
          onclick: (event) => withLoading(event.currentTarget, () => openTemplate(template)),
        },
        template.name,
      ),
    ),
    ...custom.map((template) =>
      el(
        "span",
        { class: "chip chip-custom" },
        el(
          "button",
          {
            class: "chip-button",
            type: "button",
            title: template.command,
            onclick: (event) => withLoading(event.currentTarget, () => openTemplate(template)),
          },
          template.name,
        ),
        el(
          "button",
          {
            class: "chip-remove",
            type: "button",
            "aria-label": `删除模板 ${template.name}`,
            onclick: () => void removeTemplate(template.id),
          },
          "×",
        ),
      ),
    ),
  );
}

/** 导出全部任务为 JSON 文件 */
async function exportTasks() {
  try {
    const data = await api("/api/tasks/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = el("a", { href: url, download: `cf-tg-checkin-tasks-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`已导出 ${data.tasks.length} 个任务`, { kind: "ok" });
  } catch (error) {
    toast(error.message || "导出失败", { kind: "error" });
  }
}

/** 导入任务：粘贴 JSON 或选择文件 */
function openImportDialog() {
  const area = el("textarea", {
    class: "textarea code-input",
    rows: "8",
    placeholder: '把导出文件的内容粘进来，或点「选择文件」',
    spellcheck: "false",
  });

  const fileInput = el("input", {
    type: "file",
    accept: "application/json,.json",
    class: "hidden-file",
    onchange: async (event) => {
      const file = event.currentTarget.files && event.currentTarget.files[0];
      if (!file) return;
      area.value = await file.text();
    },
  });

  openModal({
    title: "导入任务",
    body: el(
      "div",
      { class: "stack-sm" },
      el("p", { class: "hint" }, "支持本工具导出的 JSON（也接受单个任务的 JSON 数组）。导入时会自动跳过完全相同的任务。"),
      el(
        "div",
        { class: "input-row" },
        el("button", { class: "btn btn-sm", type: "button", onclick: () => fileInput.click() }, "选择文件"),
        fileInput,
      ),
      area,
    ),
    footer: el(
      "div",
      { class: "dialog-actions" },
      el("button", { class: "btn", type: "button", onclick: () => closeModal() }, "取消"),
      el(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          onclick: async (event) => {
            const text = area.value.trim();
            if (!text) {
              toast("先粘贴或选择要导入的 JSON", { kind: "error" });
              return;
            }
            await withLoading(event.currentTarget, async () => {
              try {
                const parsed = JSON.parse(text);
                const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
                const res = await api("/api/tasks/import", { method: "POST", body: { tasks } });
                toast(
                  `导入完成：新增 ${res.created} 个${res.skipped && res.skipped.length ? `，跳过 ${res.skipped.length} 个` : ""}`,
                  { kind: "ok" },
                );
                closeModal();
                await refreshState({ silent: true });
                paint({ force: true });
              } catch (error) {
                toast(error.message || "导入失败", { kind: "error" });
              }
            });
          },
        },
        "开始导入",
      ),
    ),
  });
}

function openEditor(task) {
  openTaskEditor({
    task,
    defaultTarget: (state.data && state.data.settings && state.data.settings.defaultTarget) || "",
    onSaved: async () => {
      await refreshState({ silent: true });
      paint({ force: true });
    },
  });
}

async function runTask(task, button) {
  const confirmed = await confirmDialog({
    title: "立即执行这个任务？",
    message: `会用「${task.name}」当前配置真实执行一次：发消息、点按钮都会真的发到 Telegram。手动执行不打乱原来的定时。`,
    confirmLabel: "立即执行",
  });
  if (!confirmed) return;

  await withLoading(button, async () => {
    try {
      const res = await api(`/api/tasks/${encodeURIComponent(task.id)}/run`, { method: "POST" });
      const log = res && res.log;
      const ok = res.ok !== false && (!log || log.ok !== false);
      const message = log && log.message ? log.message : ok ? "任务已执行" : "任务执行失败";
      toast(`${ok ? "成功" : "失败"} · ${message}`, { kind: ok ? "ok" : "error" });
      await refreshState({ silent: true });
    } catch (error) {
      toast(error.message || "执行失败", { kind: "error" });
    }
  });
}

async function toggleTask(task, button) {
  if (task.enabled) {
    const confirmed = await confirmDialog({
      title: "停用这个任务？",
      message: `停用后「${task.name}」不再按计划执行，配置和历史日志都保留，随时可以再启用。`,
      confirmLabel: "停用任务",
    });
    if (!confirmed) return;
  }

  await withLoading(button, async () => {
    try {
      await api(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        body: { enabled: !task.enabled },
      });
      toast(task.enabled ? `已停用「${task.name}」` : `已启用「${task.name}」`, { kind: "ok" });
      await refreshState({ silent: true });
    } catch (error) {
      toast(error.message || "操作失败", { kind: "error" });
    }
  });
}

async function deleteTask(task) {
  const ok = await confirmDialog({
    title: "删除任务",
    message: `确定删除「${task.name}」？删除后无法恢复，这个任务的执行日志也会一并删掉。`,
    confirmLabel: "删除任务",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
    toast("任务已删除", { kind: "ok" });
    await refreshState({ silent: true });
  } catch (error) {
    toast(error.message || "删除失败", { kind: "error" });
  }
}

async function runAll(button) {
  const enabledCount = ((state.data && state.data.tasks) || []).filter((task) => task.enabled).length;
  const confirmed = await confirmDialog({
    title: "执行全部任务？",
    message: enabledCount
      ? `会依次真实执行 ${enabledCount} 个已启用的任务（发消息、点按钮都会真的发生），可能要几分钟，期间别关页面。`
      : "当前没有已启用的任务。",
    confirmLabel: "开始执行",
  });
  if (!confirmed) return;

  await withLoading(button, async () => {
    try {
      let done = 0;
      let failed = 0;
      let offset = 0;
      // 服务端每次只跑一批（避免网关超时），按 offset 推进直到跑完
      for (let round = 0; round < 30; round += 1) {
        const res = await api(`/api/tasks/run-all?offset=${offset}`, { method: "POST" });
        const logs = Array.isArray(res && res.logs) ? res.logs : [];
        done += logs.length;
        failed += logs.filter((log) => !log.ok).length;
        offset = Number(res && res.nextOffset) || offset + logs.length;
        const remaining = Number(res && res.remaining) || 0;
        if (!remaining) {
          toast(
            done ? `执行了 ${done} 个任务${failed ? `，${failed} 个失败` : "，全部成功"}` : "没有可执行的任务",
            { kind: failed ? "error" : "ok" },
          );
          break;
        }
      }
      await refreshState({ silent: true });
    } catch (error) {
      toast(error.message || "执行失败", { kind: "error" });
    }
  });
}

async function runTick(button) {
  await withLoading(button, async () => {
    try {
      const res = await api("/api/tick", { method: "POST" });
      const ran = Array.isArray(res && res.ran) ? res.ran.length : 0;
      toast(ran ? `跑完了 ${ran} 个任务` : "检查完成，暂无到期的任务", { kind: "ok" });
      await refreshState({ silent: true });
    } catch (error) {
      toast(error.message || "检查失败", { kind: "error" });
    }
  });
}

/* --------------------------------------------------------------- 日志 */

async function loadLogs({ silent = false } = {}) {
  try {
    const params = new URLSearchParams({ pageSize: String(state.logPageSize), page: String(state.logPage) });
    if (state.logLevel) params.set("level", state.logLevel);
    if (state.logTaskId) params.set("taskId", String(state.logTaskId));
    if (state.logQuery) params.set("q", state.logQuery);
    if (state.logSinceHours) params.set("sinceHours", String(state.logSinceHours));
    const res = await api(`/api/logs?${params.toString()}`);
    state.logs = Array.isArray(res && res.logs) ? res.logs : [];
    state.logsTotal = res && typeof res.total === "number" ? res.total : null;
    state.logPages = res && typeof res.pages === "number" ? res.pages : 1;
    state.logPage = res && typeof res.page === "number" ? res.page : 1;
  } catch (error) {
    if (!silent) toast(error.message || "读取日志失败", { kind: "error" });
  }
  if (state.view === "logs") paint({ force: true });
}

/** 换筛选条件时回到第 1 页 */
async function reloadLogsFromFirstPage() {
  state.logPage = 1;
  state.logs = null;
  await loadLogs({ silent: true });
}

function renderLogs() {
  const logs = Array.isArray(state.logs)
    ? state.logs
    : Array.isArray(state.data.logs)
      ? state.data.logs
      : [];

  const header = pageHead({
    title: "日志",
    description:
      state.logsTotal !== undefined && state.logsTotal !== null && state.logsTotal > 0
        ? `共 ${state.logsTotal} 条${filterSummary()}，点击行可展开细节。服务端只保留最近 2000 条。`
        : "任务执行记录与错误细节。",
    actions: [
      btn("刷新", {
        iconName: "refresh",
        onClick: (event) => withLoading(event.currentTarget, () => loadLogs()),
      }),
      btn("清空日志", { iconName: "trash", className: "is-danger", onClick: clearLogs }),
    ],
  });

  const tasksForFilter = Array.isArray(state.data && state.data.tasks) ? state.data.tasks : [];
  const filters = el(
    "div",
    { class: "log-filters" },
    ...[
      ["", "全部"],
      ["ok", "成功"],
      ["fail", "失败"],
    ].map(([value, label]) =>
      el(
        "button",
        {
          class: `chip${state.logLevel === value ? " is-active" : ""}`,
          type: "button",
          onclick: async (event) => {
            state.logLevel = value;
            await withLoading(event.currentTarget, () => reloadLogsFromFirstPage());
          },
        },
        label,
      ),
    ),
    el(
      "select",
      {
        class: "input log-task-select",
        "aria-label": "按任务筛选",
        onchange: async (event) => {
          state.logTaskId = event.currentTarget.value;
          await reloadLogsFromFirstPage();
        },
      },
      el("option", { value: "" }, "全部任务"),
      ...tasksForFilter.map((task) =>
        el("option", { value: String(task.id), selected: String(state.logTaskId) === String(task.id) }, `#${task.id} ${task.name}`),
      ),
    ),
    el(
      "select",
      {
        class: "input log-time-select",
        "aria-label": "按时间范围筛选",
        onchange: async (event) => {
          state.logSinceHours = event.currentTarget.value;
          await reloadLogsFromFirstPage();
        },
      },
      ...[
        ["", "全部时间"],
        ["1", "近 1 小时"],
        ["24", "近 24 小时"],
        ["168", "近 7 天"],
      ].map(([value, label]) => el("option", { value, selected: String(state.logSinceHours) === value }, label)),
    ),
    el("input", {
      class: "input log-search",
      type: "search",
      placeholder: "搜索日志内容…",
      value: state.logQuery,
      "aria-label": "搜索日志",
      oninput: (event) => {
        const value = event.currentTarget.value.trim();
        if (value === state.logQuery) return;
        state.logQuery = value;
        clearTimeout(renderLogs._searchTimer);
        renderLogs._searchTimer = setTimeout(async () => {
          await reloadLogsFromFirstPage();
        }, 350);
      },
    }),
  );

  if (!logs.length) {
    return frag(
      header,
      el(
        "div",
        { class: "card card-pad" },
        emptyState({
          iconName: "list",
          title: "还没有执行记录",
          text: "运行任务、或发一条消息指令之后，结果会出现在这里。",
          actions: [el("a", { class: "btn", href: "#/tasks" }, "回到任务")],
        }),
      ),
    );
  }

  const goPage = (page) => {
    if (page === state.logPage) return;
    state.logPage = page;
    void loadLogs();
  };

  return frag(
    header,
    filters,
    el(
      "div",
      { class: "card log-card" },
      el("ul", { class: "log-list" }, logs.map(logItem)),
      state.logPages > 1
        ? el(
            "div",
            { class: "pager" },
            el(
              "div",
              { class: "pager-info" },
              `第 ${state.logPage} / ${state.logPages} 页 · 共 ${state.logsTotal ?? logs.length} 条`,
            ),
            el(
              "div",
              { class: "pager-actions" },
              el(
                "button",
                {
                  class: "btn btn-sm",
                  type: "button",
                  disabled: state.logPage <= 1,
                  onclick: () => goPage(state.logPage - 1),
                },
                "上一页",
              ),
            ...pageNumbers(state.logPage, state.logPages).map((item) =>
                item === "…"
                  ? el("span", { class: "pager-gap" }, "…")
                  : el(
                      "button",
                      {
                        class: `btn btn-sm pager-num${item === state.logPage ? " is-current" : ""}`,
                        type: "button",
                        "aria-current": item === state.logPage ? "page" : undefined,
                        onclick: () => goPage(item),
                      },
                      String(item),
                    ),
              ),
              el(
                "button",
                {
                  class: "btn btn-sm",
                  type: "button",
                  disabled: state.logPage >= state.logPages,
                  onclick: () => goPage(state.logPage + 1),
                },
                "下一页",
              ),
              el(
                "select",
                {
                  class: "input pager-size",
                  "aria-label": "每页条数",
                  onchange: async (event) => {
                    state.logPageSize = Number(event.currentTarget.value) || 20;
                    await reloadLogsFromFirstPage();
                  },
                },
                ...[10, 20, 50, 100].map((size) =>
                  el("option", { value: String(size), selected: size === state.logPageSize }, `每页 ${size}`),
                ),
              ),
            ),
          )
        : state.logsTotal && state.logsTotal > 0
          ? el("div", { class: "pager pager-single" }, el("div", { class: "pager-info" }, `共 ${state.logsTotal} 条`))
          : null,
    ),
  );
}

/** 生成页码序列：1 … 4 5 [6] 7 8 … 20 */
function pageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set([1, total, current, current - 1, current + 1, current - 2, current + 2]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const result = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) result.push("…");
    result.push(page);
    previous = page;
  }
  return result;
}

/** 当前筛选条件的一句话描述 */
function filterSummary() {
  const parts = [];
  if (state.logLevel === "ok") parts.push("只看成功");
  if (state.logLevel === "fail") parts.push("只看失败");
  if (state.logTaskId) {
    const task = (state.data && state.data.tasks || []).find((item) => String(item.id) === String(state.logTaskId));
    parts.push(`任务 #${state.logTaskId}${task ? ` ${task.name}` : ""}`);
  }
  if (state.logSinceHours) {
    const labels = { 1: "近 1 小时", 24: "近 24 小时", 168: "近 7 天" };
    parts.push(labels[state.logSinceHours] || `近 ${state.logSinceHours} 小时`);
  }
  if (state.logQuery) parts.push(`搜索「${state.logQuery}」`);
  return parts.length ? `（${parts.join(" · ")}）` : "";
}

/**
 * 复制文本，三种方式依次尝试：
 *  1. navigator.clipboard（需要 HTTPS / localhost）
 *  2. 临时 textarea + document.execCommand("copy")（http、旧浏览器、iframe 里可用）
 *  3. 兜底弹窗，让用户手动选中复制
 */
async function copyText(text, hint = "已复制") {
  const value = String(text ?? "");
  if (!value) return false;

  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      toast(hint, { kind: "ok" });
      return true;
    } catch {
      /* 落到 execCommand */
    }
  }

  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.left = "0";
    area.style.opacity = "0";
    document.body.append(area);

    const selection = document.getSelection();
    const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    area.select();
    area.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    area.remove();
    if (previousRange && selection) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    if (ok) {
      toast(hint, { kind: "ok" });
      return true;
    }
  } catch {
    /* 落到手动弹窗 */
  }

  // 都失败：给一个可选中的弹窗，比 toast 好用
  const area = el("textarea", { class: "textarea code-input", rows: "4", readonly: "" });
  area.value = value;
  openModal({
    title: "复制这段内容",
    body: el(
      "div",
      { class: "stack-sm" },
      el("p", { class: "hint" }, "浏览器不允许自动复制，选中后按 ⌘/Ctrl+C 即可。"),
      area,
    ),
    footer: el(
      "div",
      { class: "dialog-actions" },
      el("button", { class: "btn btn-primary", type: "button", onclick: () => closeModal() }, "关闭"),
    ),
  });
  requestAnimationFrame(() => {
    area.focus();
    area.select();
  });
  return false;
}

const LOG_SOURCE_LABEL = { auto: "自动", manual: "手动", trigger: "指令", system: "系统" };

/** 是否是一次真正的执行（排除跳过/登记/调度报警这类系统事件；老日志没有 source 只能按文案判断） */
const SYSTEM_LOG_HINT = /跳过|登记目标|触发器|调度出错|管理员 ID|自动补全|首次轮询/;
function isExecutionLog(log) {
  if (log.source) return log.source !== "system";
  return !SYSTEM_LOG_HINT.test(log.message || "");
}

/** 常见错误 → 用户可以点的那一下 */
function logFixAction(log) {
  const text = `${log.message || ""} ${log.detail || ""}`;
  if (/还没登录\s*Telegram|未登录/.test(text)) {
    return { label: "去登录", href: "#/account" };
  }
  if (/无法解析目标|找不到签到目标/.test(text)) {
    return { label: "编辑任务", taskId: log.taskId };
  }
  if (/未匹配到关键词/.test(text)) {
    return { label: "调整关键词", taskId: log.taskId };
  }
  if (/触发器轮询失败|连接中断|Disconnected|disconnected/.test(text)) {
    return { label: "重试一次", retry: true };
  }
  return null;
}

function logItem(log) {
  const id = log && log.id;
  const at = toMillis(log && log.at);
  const hasDetail = Boolean(log && log.detail);
  const expanded = state.expandedLogs.has(id);
  const dotClass = log.ok ? "ok" : log.level === "warn" ? "warn" : "fail";
  const levelText = log.ok ? "成功" : log.level === "warn" ? "警告" : "失败";
  const sourceLabel = LOG_SOURCE_LABEL[log.source] || null;
  const duration = typeof log.durationMs === "number" && log.durationMs > 0
    ? log.durationMs >= 1000
      ? `${(log.durationMs / 1000).toFixed(1)}s`
      : `${log.durationMs}ms`
    : null;
  const fix = log.ok ? null : logFixAction(log);

  const fixButton = fix
    ? el(
        "button",
        {
          class: "btn btn-sm log-fix",
          type: "button",
          onclick: async (event) => {
            event.stopPropagation();
            void api("/api/events", { method: "POST", body: { name: "failure_handled" } }).catch(() => undefined);
            if (fix.href) {
              location.hash = fix.href;
              return;
            }
            if (fix.taskId) {
              const task = (state.data && state.data.tasks || []).find((item) => item.id === fix.taskId);
              if (task) openEditor(task);
              else location.hash = "#/tasks";
              return;
            }
            if (fix.retry) {
              await withLoading(event.currentTarget, async () => {
                try {
                  await api("/api/tick", { method: "POST" });
                  toast("已重新检查一次", { kind: "ok" });
                  await loadLogs({ silent: true });
                } catch (error) {
                  toast(error.message || "重试失败", { kind: "error" });
                }
              });
            }
          },
        },
        fix.label,
      )
    : null;

  const detailId = `log-detail-${id}`;
  const detail = hasDetail || fixButton
    ? el(
        "div",
        { class: "log-detail-wrap", id: detailId, hidden: !expanded },
        hasDetail ? el("pre", { class: "log-detail" }, String(log.detail)) : null,
        fixButton ? el("div", { class: "log-actions" }, fixButton) : null,
      )
    : null;

  const expandable = Boolean(detail);
  const head = el(
    expandable ? "button" : "div",
    {
      class: `log-head${expandable ? " is-expandable" : ""}`,
      type: expandable ? "button" : undefined,
      "aria-expanded": expandable ? String(expanded) : undefined,
      "aria-controls": expandable ? detailId : undefined,
      onclick: expandable
        ? (event) => {
            const next = !state.expandedLogs.has(id);
            if (next) state.expandedLogs.add(id);
            else state.expandedLogs.delete(id);
            if (detail) detail.hidden = !next;
            event.currentTarget.setAttribute("aria-expanded", String(next));
            const chevron = event.currentTarget.querySelector(".log-chevron");
            if (chevron) chevron.classList.toggle("is-open", next);
          }
        : undefined,
    },
    el("span", { class: `dot ${dotClass}`, title: levelText }),
    el(
      "span",
      { class: "log-msg" },
      log.message || "（无消息）",
      log.ok ? null : el("span", { class: "log-level" }, levelText),
    ),
    el(
      "span",
      { class: "log-meta" },
      el("span", { class: "log-task" }, log.taskName || "系统"),
      sourceLabel ? el("span", { class: "log-src" }, sourceLabel) : null,
      duration ? el("span", { class: "log-dur num" }, duration) : null,
      el("span", { class: "log-sep", "aria-hidden": "true" }, "·"),
      el(
        "span",
        {
          class: "num",
          title: formatFullTime(at),
          dataset: { relative: at ? String(at) : "" },
        },
        at ? formatRelative(at) : "—",
      ),
      expandable ? icon("chevron", { size: 14, className: "log-chevron" }) : null,
    ),
  );

  return el("li", { class: "log-item" }, head, detail);
}

async function clearLogs() {
  const ok = await confirmDialog({
    title: "清空日志",
    message: "将删除所有执行记录。任务和设置不受影响。",
    confirmLabel: "清空日志",
    danger: true,
  });
  if (!ok) return;
  try {
    await api("/api/logs/clear", { method: "POST" });
    state.logs = [];
    state.expandedLogs.clear();
    toast("日志已清空", { kind: "ok" });
    await refreshState({ silent: true });
    paint({ force: true });
  } catch (error) {
    toast(error.message || "清空失败", { kind: "error" });
  }
}

/* --------------------------------------------------------------- 账号 */

function renderAccount() {
  const account = (state.data && state.data.account) || {};
  const header = pageHead({
    title: "账号",
    description: "这两个值只在服务端保存，网页不会再显示。",
  });

  if (account.signedIn && account.me) {
    return frag(header, account.lastError ? banner("warn", account.lastError) : null, profileCard(account));
  }

  const pending = account.pendingLogin;
  const pendingBanner =
    pending && state.accountStep === 1
      ? el(
          "div",
          { class: "banner banner-info" },
          icon("info", { size: 15 }),
          el(
            "div",
            { class: "banner-text" },
            el(
              "span",
              {},
              `上次登录未完成（${pending.stage === "password" ? "等待两步验证密码" : "等待验证码"}）。`,
            ),
            el(
              "button",
              {
                class: "btn btn-sm btn-ghost",
                type: "button",
                onclick: () => continueLogin(pending.stage),
              },
              "继续登录",
            ),
          ),
        )
      : null;

  return frag(
    header,
    account.lastError ? banner("warn", account.lastError) : null,
    pendingBanner,
    wizardCard(account),
  );
}

function continueLogin(stage) {
  state.accountStep = stage === "password" ? 3 : 2;
  paint({ force: true });
}

function wizardCard(account) {
  const step = state.accountStep;
  const pending = account.pendingLogin || {};
  const body = el(
    "div",
    { class: "wizard" },
    stepper(step),
    step === 1 ? stepCredentials(account, pending) : step === 2 ? stepCode(account, pending) : stepPassword(account),
  );
  return card({
    title: "登录 Telegram 账号",
    description: "用你在 my.telegram.org 申请的应用登录，三步完成。",
    body,
  });
}

function stepper(step) {
  const items = ["填写应用信息", "输入验证码", "两步验证密码"];
  return el(
    "ol",
    { class: "stepper" },
    items.map((label, index) => {
      const n = index + 1;
      const classes = ["stepper-item"];
      if (n === step) classes.push("is-current");
      if (n < step) classes.push("is-done");
      return el(
        "li",
        { class: classes.join(" "), "aria-current": n === step ? "step" : undefined },
        el("span", { class: "stepper-index" }, n < step ? icon("check", { size: 12 }) : String(n)),
        el("span", { class: "stepper-label" }, label),
      );
    }),
  );
}

function stepCredentials(account, pending) {
  const form = el("form", { class: "form-grid", onsubmit: submitCredentials });
  const apiIdValue =
    account.apiId && !String(account.apiId).includes("*") ? String(account.apiId) : "";

  form.append(
    el(
      "p",
      { class: "form-note" },
      "在 ",
      el(
        "a",
        { class: "link", href: "https://my.telegram.org", target: "_blank", rel: "noopener noreferrer" },
        "my.telegram.org",
      ),
      " 的 API development tools 里创建一个应用，就能看到这两个值。它们只会发给服务端。",
    ),
    field({
      id: "account-api-id",
      label: "应用 ID",
      control: el("input", {
        class: "input",
        id: "account-api-id",
        name: "apiId",
        inputmode: "numeric",
        autocomplete: "off",
        placeholder: "123456",
        value: apiIdValue,
        required: true,
      }),
      hint: "纯数字。my.telegram.org 里叫 api_id。",
    }),
    field({
      id: "account-api-hash",
      label: "应用密钥",
      control: el("input", {
        class: "input",
        id: "account-api-hash",
        name: "apiHash",
        type: "password",
        autocomplete: "off",
        spellcheck: "false",
        placeholder: "32 位字符串",
        required: true,
      }),
      hint: "只在服务端保存；重新登录时需要再填一次。",
    }),
    field({
      id: "account-phone",
      label: "手机号",
      control: el("input", {
        class: "input",
        id: "account-phone",
        name: "phone",
        type: "tel",
        inputmode: "tel",
        autocomplete: "tel",
        placeholder: "+8613800000000",
        value: pending.phone || account.phone || "",
        required: true,
      }),
      hint: "国际格式，含国家码，例如 +8613800000000。",
    }),
    formErrorNode(),
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn btn-primary", type: "submit" }, "发送验证码"),
    ),
  );
  return form;
}

function stepCode(account, pending) {
  const form = el("form", { class: "form-grid", onsubmit: submitCode });
  const phone = pending.phone || state.accountPhone || account.phone || "确认账号";
  form.append(
    el("p", { class: "form-note" }, `验证码已发送到 ${phone}，在 Telegram 的「Telegram 服务通知」里查看。`),
    state.accountHint ? banner("info", state.accountHint) : null,
    field({
      id: "account-code",
      label: "验证码",
      control: el("input", {
        class: "input",
        id: "account-code",
        name: "code",
        inputmode: "numeric",
        autocomplete: "one-time-code",
        placeholder: "12345",
        required: true,
        "data-autofocus": "",
      }),
      hint: "5 位左右数字；如果没收到，可以返回上一步重新发送。",
    }),
    formErrorNode(),
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn", type: "button", onclick: resetWizard }, "返回"),
      el("button", { class: "btn btn-primary", type: "submit" }, "登录"),
    ),
  );
  return form;
}

function stepPassword() {
  const form = el("form", { class: "form-grid", onsubmit: submitPassword });
  form.append(
    el("p", { class: "form-note" }, "该账号开启了两步验证（2FA），请输入两步验证密码。"),
    field({
      id: "account-password",
      label: "两步验证密码",
      control: el("input", {
        class: "input",
        id: "account-password",
        name: "password",
        type: "password",
        autocomplete: "current-password",
        placeholder: "••••••••",
        required: true,
        "data-autofocus": "",
      }),
      hint: "只用于本次登录，不会存进日志。",
    }),
    formErrorNode(),
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn", type: "button", onclick: resetWizard }, "返回"),
      el("button", { class: "btn btn-primary", type: "submit" }, "完成登录"),
    ),
  );
  return form;
}

function formErrorNode() {
  return el("p", { class: "form-error", role: "alert", hidden: true });
}

function setFormError(form, message) {
  const box = form.querySelector(".form-error");
  if (!box) {
    if (message) toast(message, { kind: "error" });
    return;
  }
  box.textContent = message || "";
  box.hidden = !message;
}

function resetWizard() {
  state.accountStep = 1;
  state.accountHint = "";
  paint({ force: true });
}

/** 读取表单字段（不依赖表单的命名属性代理，跨浏览器/测试环境更稳）。 */
function formValue(form, name) {
  const node = form.elements.namedItem(name);
  return node && "value" in node ? String(node.value || "") : "";
}

async function submitCredentials(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const apiId = Number(formValue(form, "apiId").trim());
  const apiHash = formValue(form, "apiHash").trim();
  const phone = formValue(form, "phone").trim();

  if (!Number.isFinite(apiId) || apiId <= 0) return setFormError(form, "应用 ID 需要是数字");
  if (!apiHash) return setFormError(form, "请填写应用密钥");
  if (!/^\+?\d{6,}$/.test(phone)) return setFormError(form, "手机号需要国际格式，例如 +8613800000000");

  setFormError(form, "");
  await withLoading(form.querySelector('[type="submit"]'), async () => {
    try {
      const res = await api("/api/account/send-code", {
        method: "POST",
        body: { apiId, apiHash, phone },
      });
      state.accountHint = (res && res.hint) || "";
      state.accountPhone = phone;
      if (res && res.stage === "password") {
        state.accountStep = 3;
        toast("该账号需要两步验证密码", { kind: "ok" });
      } else {
        state.accountStep = 2;
        toast("验证码已发送，请在 Telegram 查看", { kind: "ok" });
      }
      await refreshState({ silent: true });
      paint({ force: true });
    } catch (error) {
      setFormError(form, error.message || "发送验证码失败");
    }
  });
}

async function submitCode(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const code = formValue(form, "code").trim();
  if (!/^\d{3,8}$/.test(code)) return setFormError(form, "验证码应为 3–8 位数字");

  setFormError(form, "");
  await withLoading(form.querySelector('[type="submit"]'), async () => {
    try {
      const res = await api("/api/account/sign-in", { method: "POST", body: { code } });
      if (res && res.stage === "password") {
        state.accountStep = 3;
        toast("该账号开启了两步验证，请继续输入密码", { kind: "ok" });
        paint({ force: true });
        return;
      }
      await afterSignIn(res);
    } catch (error) {
      setFormError(form, error.message || "登录失败");
    }
  });
}

async function submitPassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const password = formValue(form, "password");
  if (!password) return setFormError(form, "请输入两步验证密码");

  setFormError(form, "");
  await withLoading(form.querySelector('[type="submit"]'), async () => {
    try {
      const res = await api("/api/account/sign-in", { method: "POST", body: { password } });
      if (res && res.stage === "password") {
        setFormError(form, "密码不正确，请再试一次");
        return;
      }
      await afterSignIn(res);
    } catch (error) {
      setFormError(form, error.message || "登录失败");
    }
  });
}

async function afterSignIn(res) {
  state.accountStep = 1;
  state.accountHint = "";
  const me = res && res.me;
  toast(me ? `已登录：${me.firstName || me.username || me.id}` : "Telegram 账号已登录", { kind: "ok" });
  await refreshState({ silent: true });
  paint({ force: true });
}

function profileCard(account) {
  const me = account.me || {};
  const initial = String(me.firstName || me.username || "T").trim().slice(0, 1).toUpperCase();
  return card({
    title: "当前账号",
    actions: [
      btn("退出登录", {
        iconName: "logout",
        className: "is-danger",
        onClick: logoutAccount,
      }),
    ],
    body: el(
      "div",
      { class: "profile" },
      el("div", { class: "avatar", "aria-hidden": "true" }, initial),
      el(
        "div",
        { class: "profile-main" },
        el("div", { class: "profile-name" }, me.firstName || me.username || `id ${me.id}`),
        el("div", { class: "profile-sub" }, me.username ? `@${me.username}` : "未设置 username"),
        el(
          "div",
          { class: "meta-list" },
          metaRow(
            "连接状态",
            account.connected
              ? "已连接（正在和 Telegram 通信）"
              : account.lastConnectedAt
                ? `空闲（按需连接，上次成功连接 ${formatRelative(account.lastConnectedAt)}）`
                : "空闲（需要时自动连接，比如下次执行任务）",
          ),
          metaRow("用户 id", String(me.id ?? "—")),
          metaRow("手机号", account.phone ? maskPhone(account.phone) : "—"),
          metaRow("应用 ID", account.apiId ? String(account.apiId) : "—"),
        ),
      ),
    ),
  });
}

function metaRow(label, value) {
  return el("div", { class: "meta-row" }, el("span", { class: "meta-label" }, label), el("span", { class: "meta-value" }, value));
}

function maskPhone(phone) {
  const text = String(phone);
  if (text.length <= 7) return text;
  return `${text.slice(0, 4)}${"*".repeat(Math.max(2, text.length - 7))}${text.slice(-3)}`;
}

async function logoutAccount() {
  const ok = await confirmDialog({
    title: "退出 Telegram 账号",
    message: "退出后会清除登录状态，定时任务在重新登录前不会执行。",
    confirmLabel: "退出账号",
    danger: true,
  });
  if (!ok) return;
  try {
    await api("/api/account/logout", { method: "POST" });
    state.accountStep = 1;
    state.accountHint = "";
    toast("Telegram 账号已退出", { kind: "ok" });
    await refreshState({ silent: true });
    paint({ force: true });
  } catch (error) {
    toast(error.message || "退出失败", { kind: "error" });
  }
}

/* --------------------------------------------------------------- 设置 */

/** 设置页的分组容器（可折叠，状态记在 localStorage） */
const SETTINGS_TAB_KEY = "cf-tg.settings.tab";

/** 记住上次停在哪个二级 tab（默认「执行」） */
function activeSettingsTab() {
  try {
    return localStorage.getItem(SETTINGS_TAB_KEY) || "schedule";
  } catch {
    return "schedule";
  }
}

/**
 * 设置页的二级 tab 面板。
 *
 * 设置项一多，一页拉下来太长 —— 现在按「执行 / 消息指令 / 登录与安全 / 关于」分 tab。
 * 注意：非当前 tab 的**只是 hidden，不是不渲染**，保存时仍然一次提交所有字段。
 */
function settingsPanel(id, _title, fields) {
  return el(
    "section",
    {
      class: "settings-panel",
      id: `settings-panel-${id}`,
      role: "tabpanel",
      "aria-labelledby": `settings-tab-${id}`,
      dataset: { panel: id },
    },
    // 标题已经由二级 tab 表达，这里不再重复显示（保留 aria-labelledby 供读屏）
    ...fields.filter(Boolean),
  );
}

/** 二级 tab 栏 + 面板容器（只显示当前 tab） */
function settingsTabs(groups) {
  const current = groups.some((group) => group.id === activeSettingsTab()) ? activeSettingsTab() : groups[0].id;

  const panels = el("div", { class: "settings-panels" }, ...groups.map((group) => group.panel));

  const buttons = groups.map((group) =>
    el(
      "button",
      {
        class: `tab tab-sub${group.id === current ? " is-active" : ""}`,
        type: "button",
        role: "tab",
        id: `settings-tab-${group.id}`,
        "aria-selected": String(group.id === current),
        "aria-controls": `settings-panel-${group.id}`,
        dataset: { tab: group.id },
        onclick: () => activate(group.id),
        onkeydown: (event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          event.preventDefault();
          const index = groups.findIndex((item) => item.id === (event.currentTarget.dataset.tab || ""));
          const next = groups[(index + (event.key === "ArrowRight" ? 1 : groups.length - 1)) % groups.length];
          if (next) activate(next.id, true);
        },
      },
      group.title,
      group.hint ? el("span", { class: "tab-hint" }, group.hint) : null,
    ),
  );

  function activate(id, focus = false) {
    for (const button of buttons) {
      const on = button.dataset.tab === id;
      button.classList.toggle("is-active", on);
      button.setAttribute("aria-selected", String(on));
      if (on && focus) button.focus();
    }
    for (const panel of panels.children) {
      panel.hidden = panel.dataset.panel !== id;
    }
    try {
      localStorage.setItem(SETTINGS_TAB_KEY, id);
    } catch {
      /* 隐私模式忽略 */
    }
  }

  for (const panel of panels.children) {
    panel.hidden = panel.dataset.panel !== current;
  }

  return {
    bar: el("div", { class: "tabbar tabbar-sub", role: "tablist", "aria-label": "设置分组" }, ...buttons),
    panels,
  };
}

const REPO_URL = "https://github.com/mihucho/cf-tg-checkin";

function renderSettings() {
  const settings = (state.data && state.data.settings) || {};
  const account = (state.data && state.data.account) || {};
  const runtime = (state.data && state.data.runtime) || {};

  const form = el("form", {
    class: "form-grid",
    id: "settings-form",
    onsubmit: saveSettings,
    oninput: (event) => {
      event.currentTarget.dataset.dirty = "1";
    },
    onchange: (event) => {
      event.currentTarget.dataset.dirty = "1";
    },
  });

  const meId = account.me && account.me.id ? String(account.me.id) : "";

  const groupSchedule = settingsPanel("schedule", "执行", [
    el(
      "div",
      { class: "form-row" },
      field({
        id: "settings-timezone",
        label: "时区（UTC 偏移）",
        control: numberControl("timezone", settings.timezone ?? 8, { step: "0.5", min: "-12", max: "14" }),
        hint: "按小时计的 UTC 偏移。北京时间填 8，支持小数（如 5.5）。",
      }),
      field({
        id: "settings-stepPollSeconds",
        label: "按钮检测间隔（秒）",
        control: numberControl("stepPollSeconds", settings.stepPollSeconds ?? 3, { step: "1", min: "1", max: "30" }),
        hint: "机器人回复后，按此间隔检查下一步按钮是否出现。",
      }),
    ),
    field({
      id: "settings-stepWaitSeconds",
      label: "按钮等待上限（秒）",
      control: numberControl("stepWaitSeconds", settings.stepWaitSeconds ?? 30, { step: "5", min: "5", max: "300" }),
      hint: "超过该时长仍无下一步按钮，则判定这一步失败。",
    }),
  ]);

  const groupTrigger = settingsPanel("trigger", "消息指令", [
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-label" }, "启用消息指令"),
      el(
        "label",
        { class: "switch" },
        el("input", { type: "checkbox", name: "triggerEnabled", checked: Boolean(settings.triggerEnabled) }),
        el("span", { class: "switch-track", "aria-hidden": "true" }),
        el("span", { class: "switch-text" }, "允许用 Telegram 消息管理任务"),
      ),
      el("p", { class: "field-hint" }, "关闭后不再读取新消息；已有任务的定时不受影响。"),
    ),
    el(
      "div",
      { class: "form-row" },
      field({
        id: "settings-controlChat",
        label: "指令来源",
        control: textControl("controlChat", settings.controlChat ?? "self", "self"),
        hint: "默认读收藏夹。也可以填群组用户名或数字 ID。",
      }),
      field({
        id: "settings-pollSeconds",
        label: "检查间隔（秒）",
        control: numberControl("pollSeconds", settings.pollSeconds ?? 60, { step: "5", min: "15", max: "3600" }),
        hint: "读取新消息的频率。越短越及时，但请求量也越大。",
      }),
    ),
    el(
      "div",
      { class: "form-row" },
      field({
        id: "settings-triggerPrefix",
        label: "指令前缀",
        control: textControl("triggerPrefix", settings.triggerPrefix ?? "", "默认 tg；留空 = 解析全部"),
        hint: "仅以该前缀开头的消息会被解析为指令。留空表示解析全部消息。",
      }),
      field({
        id: "settings-adminUserId",
        label: "管理员 ID",
        control: textControl("adminUserId", settings.adminUserId ?? "", meId || "登录后自动填入", "numeric"),
        hint: meId ? `仅该 Telegram 账号发出的指令有效（当前账号 ${meId}）。` : "登录后自动填入当前账号。",
      }),
    ),
    field({
      id: "settings-defaultTarget",
      label: "默认目标",
      control: textControl("defaultTarget", settings.defaultTarget ?? "", "@username 或数字 ID"),
      hint: "指令中未能识别目标时使用，例如 @jerry_bot。",
    }),
  ]);

  const panel = el("div", { class: "notify-test-result", hidden: true });
  const groupSecurity = settingsPanel("security", "登录与安全", [
    el(
      "div",
      { class: "check-row" },
      el("input", {
        type: "checkbox",
        id: "settings-notifyOnFailure",
        name: "notifyOnFailure",
        checked: settings.notifyOnFailure !== false,
      }),
      el("label", { for: "settings-notifyOnFailure" }, "同时在 Telegram 里给自己发一条（关掉就只走 Webhook）"),
    ),
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-label" }, "通知类型"),
      el(
        "div",
        { class: "notify-types" },
        ...((state.data && state.data.notifyCatalog) || []).map((item) => {
          const checked = (settings.notifyEvents || []).includes(item.id);
          const extras = notifyExtras(item.id, settings);
          return el(
            "label",
            { class: `notify-type${checked ? " is-on" : ""}` },
            el("input", {
              type: "checkbox",
              name: "notifyEvents",
              value: item.id,
              checked,
              onchange: (event) => {
                event.currentTarget.closest(".notify-type")?.classList.toggle("is-on", event.currentTarget.checked);
              },
            }),
            el(
              "span",
              { class: "notify-type-body" },
              el(
                "span",
                { class: "notify-type-head" },
                el("span", { class: "notify-type-label" }, item.label),
                extras,
              ),
              el("span", { class: "notify-type-hint" }, item.hint),
            ),
          );
        }),
      ),
      el("p", { class: "field-hint" }, "勾选的事件会推到上面的 Webhook；开了「同时在 Telegram 里提醒」也会发到你的私聊。"),
    ),
    field({
      id: "settings-notifyWebhookKind",
      label: "Webhook 渠道",
      control: selectControl("notifyWebhookKind", settings.notifyWebhookKind || "generic", [
        ["dingtalk", "钉钉自定义机器人"],
        ["wecom", "企业微信群机器人"],
        ["feishu", "飞书自定义机器人"],
        ["generic", "自定义渠道（自建服务）"],
      ]),
      hint: "选了渠道地址就固定了，只需要填机器人的 Token；自建服务才填完整地址。",
    }),
    el(
      "div",
      { class: "field", id: "settings-webhook-token-field" },
      el("label", { class: "field-label", for: "settings-notifyWebhookToken" }, WEBHOOK_TOKEN_LABEL[settings.notifyWebhookKind || "generic"] || "机器人 Token"),
      el("input", {
        class: "input",
        id: "settings-notifyWebhookToken",
        name: "notifyWebhookToken",
        type: "password",
        autocomplete: "off",
        spellcheck: "false",
        placeholder: "粘贴机器人 Token，或整条 Webhook 地址",
        value: WEBHOOK_TOKEN_OF(settings),
      }),
      el("p", { class: "field-hint", id: "settings-webhook-url-hint" }, WEBHOOK_URL_HINT[settings.notifyWebhookKind || "generic"] || ""),
    ),
    field({
      id: "settings-notifyWebhook",
      label: "Webhook 地址",
      control: textControl("notifyWebhook", settings.notifyWebhook ?? "", "https://你的服务/hook"),
      hint: "自定义渠道：失败时向该地址发一份 JSON（含任务编号、任务名、结果、时间）。",
    }),
    field({
      id: "settings-notifyWebhookSecret",
      label: "钉钉加签密钥（可选）",
      control: el("input", {
        class: "input",
        id: "settings-notifyWebhookSecret",
        name: "notifyWebhookSecret",
        type: "password",
        autocomplete: "new-password",
        spellcheck: "false",
        placeholder: settings.notifyWebhookSecretConfigured ? "已配置（留空表示不修改）" : "机器人安全设置里的「加签」密钥",
      }),
      hint: "只有钉钉需要：机器人在安全设置里开启「加签」时填这里。只存在服务端，不会回传。",
    }),
    el(
      "div",
      { class: "check-row" },
      el("input", { type: "checkbox", id: "settings-clearNotifyWebhookSecret", name: "clearNotifyWebhookSecret" }),
      el("label", { for: "settings-clearNotifyWebhookSecret" }, "清除已保存的加签密钥"),
    ),
    el(
      "div",
      { class: "notify-test" },
      el(
        "button",
        {
          class: "btn btn-sm",
          type: "button",
          onclick: (event) =>
            withLoading(event.currentTarget, () => {
              const form = event.currentTarget.closest("form");
              const read = (name) => {
                const node = form && form.elements.namedItem(name);
                return node && "value" in node ? String(node.value).trim() : "";
              };
              const checked = (name) => {
                const node = form && form.elements.namedItem(name);
                return Boolean(node && node.checked);
              };
              const kind = read("notifyWebhookKind") || "generic";
              const overlay = {
                notifyWebhookKind: kind,
                ...(kind === "generic"
                  ? { notifyWebhook: read("notifyWebhook") }
                  : { notifyWebhookToken: read("notifyWebhookToken") }),
                notifyOnFailure: checked("notifyOnFailure"),
                notifyEvents: [...(form ? form.querySelectorAll('input[name="notifyEvents"]:checked') : [])].map(
                  (node) => node.value,
                ),
              };
              if (read("notifyWebhookSecret")) overlay.notifyWebhookSecret = read("notifyWebhookSecret");
              return sendTestNotification(panel, overlay);
            }),
        },
        "发送测试通知",
      ),
      el("span", { class: "field-hint" }, "直接用表单里当前填的值发一条（不用先保存），能立刻看出地址/加签/关键词对不对。"),
    ),
    panel,
    field({
      id: "settings-turnstileSiteKey",
      label: "Turnstile 站点密钥（Site Key）",
      control: textControl("turnstileSiteKey", settings.turnstileSiteKey ?? "", "例如 0x4AAAAAAA…"),
      hint: "Cloudflare 控制台 → Turnstile → Add site 里获取。填了才会在登录页出现验证框。",
    }),
    field({
      id: "settings-turnstileSecret",
      label: "Turnstile 私钥（Secret Key）",
      control: el("input", {
        class: "input",
        id: "settings-turnstileSecret",
        name: "turnstileSecretKey",
        type: "password",
        autocomplete: "new-password",
        spellcheck: "false",
        placeholder: settings.turnstileSecretConfigured ? "已配置（留空表示不修改）" : "例如 0x4AAAAAAA…",
      }),
      hint: "只存在服务端，接口不会回传。留空保存 = 保持不变。",
    }),
    el(
      "div",
      { class: "check-row" },
      el("input", { type: "checkbox", id: "settings-clearTurnstile", name: "clearTurnstileSecret" }),
      el("label", { for: "settings-clearTurnstile" }, "清除已保存的私钥（关闭人机验证）"),
    ),
  ]);

  const groupAbout = settingsPanel(
    "about",
    "关于",
    [
      el(
        "div",
        { class: "stack-sm" },
        el("div", { class: "about-build", id: "about-build" }, state.build ? "" : "读取中…"),
        el(
          "div",
          { class: "about-build" },
          `出口机房 ${runtime.colo || "未记录"}` + (runtime.locationHint ? ` · 部署区域 ${runtime.locationHint}` : ""),
        ),
        usagePanel(),
        el(
          "div",
          { class: "about-links" },
          ...[
            ["使用说明", `${REPO_URL}#readme`],
            ["部署与排查", `${REPO_URL}/blob/main/docs/DEPLOY.md`],
            ["安全说明", `${REPO_URL}/blob/main/SECURITY.md`],
            ["反馈问题", `${REPO_URL}/issues`],
          ].map(([label, href]) =>
            el("a", { class: "link", href, target: "_blank", rel: "noopener noreferrer" }, label),
          ),
        ),
      ),
    ],
  );

  const tabs = settingsTabs([
    { id: "schedule", title: "执行", panel: groupSchedule },
    { id: "trigger", title: "消息指令", panel: groupTrigger },
    { id: "security", title: "登录与安全", panel: groupSecurity },
    { id: "about", title: "关于", panel: groupAbout },
  ]);

  form.append(
    tabs.bar,
    tabs.panels,
    el(
      "div",
      { class: "form-actions form-actions-sticky" },
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: (event) => {
            const node = event.currentTarget.closest("form");
            if (node) node.dataset.dirty = "";
            paint({ force: true });
          },
        },
        "撤销更改",
      ),
      el("button", { class: "btn btn-primary", type: "submit" }, "保存设置"),
    ),
  );

  // 渠道一换，token / 地址输入框就互斥显示
  const kindSelect = form.querySelector('#settings-notifyWebhookKind');
  const tokenField = form.querySelector('#settings-webhook-token-field');
  const urlField = form.querySelector('#settings-notifyWebhook')?.closest(".field");
  const tokenLabel = tokenField?.querySelector(".field-label");
  const urlHint = form.querySelector('#settings-webhook-url-hint');
  const syncWebhookFields = () => {
    const kind = kindSelect ? kindSelect.value : "generic";
    const custom = kind === "generic";
    if (tokenField) tokenField.hidden = custom;
    if (urlField) urlField.hidden = !custom;
    if (tokenLabel) tokenLabel.textContent = WEBHOOK_TOKEN_LABEL[kind] || "机器人 Token";
    if (urlHint) urlHint.textContent = WEBHOOK_URL_HINT[kind] || "";
    const signField = form.querySelector('#settings-notifyWebhookSecret')?.closest(".field");
    const signClearRow = form.querySelector('#settings-clearNotifyWebhookSecret')?.closest(".check-row");
    if (signField) signField.hidden = kind !== "dingtalk";
    if (signClearRow) signClearRow.hidden = kind !== "dingtalk";
  };
  // 换渠道时把上一家的 token 清掉：不同平台的 token 不通用，
  // 留着很容易「切到钉钉但填的是企微 key」，然后一直 300005。
  let lastKind = kindSelect ? kindSelect.value : "generic";
  const tokenInput = form.querySelector("#settings-notifyWebhookToken");
  kindSelect?.addEventListener("change", () => {
    const kind = kindSelect.value;
    if (tokenInput && kind !== lastKind) tokenInput.value = "";
    lastKind = kind;
    syncWebhookFields();
  });
  syncWebhookFields();


  return frag(
    pageHead({ title: "设置", description: "执行时间、消息指令与登录安全。" }),
    card({ title: "偏好设置", description: "保存后立即生效。", body: form }),
    testerCard(),
    triggerHelp(),
  );
}

function numberControl(name, value, { step = "1", min, max } = {}) {
  return el("input", {
    class: "input",
    id: `settings-${name}`,
    name,
    type: "number",
    inputmode: "decimal",
    step,
    min,
    max,
    value: String(value ?? ""),
  });
}

/** 「通知类型」卡片里的附加控件：日报/周报的时间、存储与成功率阈值 */
function notifyExtras(id, settings) {
  const hourOptions = Array.from({ length: 24 }, (_, hour) => hour).map((hour) =>
    el(
      "option",
      { value: String(hour), selected: Number(settings.digestHour ?? 22) === hour },
      `${String(hour).padStart(2, "0")}:00`,
    ),
  );

  if (id === "daily_digest") {
    return el("span", { class: "notify-type-time" }, el("select", {
      class: "input input-tiny",
      name: "digestHour",
      "aria-label": "日报发送时间",
      onchange: (event) => event.stopPropagation(),
    }, ...hourOptions));
  }

  if (id === "weekly_digest") {
    const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    return el(
      "span",
      { class: "notify-type-time" },
      el("select", {
        class: "input input-tiny",
        name: "digestWeekday",
        "aria-label": "周报发送星期",
        onchange: (event) => event.stopPropagation(),
      }, ...weekdays.map((label, index) =>
        el("option", { value: String(index), selected: Number(settings.digestWeekday ?? 0) === index }, label),
      )),
      el("select", {
        class: "input input-tiny",
        name: "weeklyHour",
        "aria-label": "周报发送时间",
        onchange: (event) => event.stopPropagation(),
      }, ...Array.from({ length: 24 }, (_, hour) => hour).map((hour) =>
        el(
          "option",
          { value: String(hour), selected: Number(settings.weeklyHour ?? 22) === hour },
          `${String(hour).padStart(2, "0")}:00`,
        ),
      )),
    );
  }

  if (id === "storage_warning") {
    const value = el("input", {
      class: "input input-tiny input-num",
      type: "number",
      name: "storageWarnPercent",
      min: "0",
      max: "99",
      step: "5",
      value: String(settings.storageWarnPercent ?? 70),
      "aria-label": "存储告警阈值（百分比）",
      onchange: (event) => event.stopPropagation(),
      onclick: (event) => event.stopPropagation(),
    });
    return el("span", { class: "notify-type-time" }, value, el("span", { class: "notify-type-unit" }, "%"));
  }

  if (id === "success_rate_low") {
    const value = el("input", {
      class: "input input-tiny input-num",
      type: "number",
      name: "successRateThreshold",
      min: "0",
      max: "99",
      step: "5",
      value: String(settings.successRateThreshold ?? 80),
      "aria-label": "成功率告警阈值（百分比）",
      onchange: (event) => event.stopPropagation(),
      onclick: (event) => event.stopPropagation(),
    });
    return el("span", { class: "notify-type-time" }, value, el("span", { class: "notify-type-unit" }, "%"));
  }

  return null;
}

/** 发送测试通知：把两个通道的真实结果列出来 */
async function sendTestNotification(panel, overlay = {}) {
  panel.hidden = false;
  panel.textContent = "";
  panel.append(el("div", { class: "notify-test-line muted" }, "正在发送…"));
  try {
    const res = await api("/api/notify/test", { method: "POST", body: overlay });
    const result = (res && res.result) || {};
    const lines = [];

    const telegram = result.telegram || {};
    if (telegram.ok) lines.push(["ok", "Telegram 私聊：已发送"]);
    else lines.push(["error", `Telegram 私聊：${telegram.error || "发送失败"}`]);

    const webhook = result.webhook || {};
    const channelLabels = { dingtalk: "钉钉", wecom: "企业微信", feishu: "飞书", generic: "通用 JSON" };
    const channel = channelLabels[webhook.kind] || webhook.kind || "Webhook";
    if (webhook.ok) lines.push(["ok", `${channel}：已发送`]);
    else if (webhook.skipped) lines.push(["muted", `${channel}：${webhook.error || "未配置"}（跳过）`]);
    else lines.push(["error", `${channel}：${webhook.error || "推送失败"}`]);
    if (webhook.target) lines.push(["muted", `推送地址：${webhook.target}`]);

    panel.textContent = "";
    for (const [kind, text] of lines) {
      panel.append(
        el(
          "div",
          { class: `notify-test-line is-${kind}` },
          el("span", { class: "dot", class: kind === "ok" ? "dot ok" : kind === "error" ? "dot danger" : "dot idle" }),
          el("span", {}, text),
        ),
      );
    }
    const anyOk = lines.some(([kind]) => kind === "ok");
    toast(anyOk ? "测试通知已发送" : "测试通知没发出去，看下面的原因", { kind: anyOk ? "ok" : "error" });
  } catch (error) {
    panel.textContent = "";
    panel.append(el("div", { class: "notify-test-line is-error" }, error.message || "请求失败"));
    toast(error.message || "测试失败", { kind: "error" });
  }
}

const WEBHOOK_TOKEN_LABEL = {
  dingtalk: "机器人 Token（access_token）",
  wecom: "机器人 Key",
  feishu: "机器人 Token",
  generic: "Webhook 地址",
};

const WEBHOOK_URL_HINT = {
  dingtalk: "固定推送到 https://oapi.dingtalk.com/robot/send?access_token=<Token>（加签密钥在下面单独填）",
  wecom: "固定推送到 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<Key>",
  feishu: "固定推送到 https://open.feishu.cn/open-apis/bot/v2/hook/<Token>",
  generic: "自建服务：填完整地址，内容是一份通用 JSON。",
};

/** 已保存的完整地址 → 回填到输入框的 token */
function WEBHOOK_TOKEN_OF(settings) {
  const kind = settings.notifyWebhookKind || "generic";
  const url = String(settings.notifyWebhook || "");
  if (!url) return "";
  if (kind === "generic") return url;
  try {
    const parsed = new URL(url);
    if (kind === "wecom") return parsed.searchParams.get("key") || "";
    if (kind === "dingtalk") return parsed.searchParams.get("access_token") || "";
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || "";
  } catch {
    return url;
  }
}

function selectControl(name, value, options) {
  const node = el("select", { class: "input", id: `settings-${name}`, name });
  for (const [optionValue, label] of options) {
    node.append(el("option", { value: optionValue, selected: String(value) === optionValue }, label));
  }
  return node;
}

function textControl(name, value, placeholder = "", inputmode) {
  return el("input", {
    class: "input",
    id: `settings-${name}`,
    name,
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    inputmode,
    placeholder,
    value: value === null || value === undefined ? "" : String(value),
  });
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const read = (name) => {
    const node = form.elements.namedItem(name);
    return node && "value" in node ? String(node.value) : "";
  };
  const checked = (name) => {
    const node = form.elements.namedItem(name);
    return Boolean(node && node.checked);
  };

  const timezone = Number(read("timezone"));
  const pollSeconds = Number(read("pollSeconds"));
  const stepPollSeconds = Number(read("stepPollSeconds"));
  const stepWaitSeconds = Number(read("stepWaitSeconds"));

  if (!Number.isFinite(timezone) || timezone < -12 || timezone > 14) {
    toast("时区偏移需要在 -12 到 14 之间", { kind: "error" });
    return;
  }
  if (!Number.isFinite(pollSeconds) || pollSeconds < 15 || pollSeconds > 3600) {
    toast("检查间隔需要在 15–3600 秒之间", { kind: "error" });
    return;
  }
  if (!Number.isFinite(stepPollSeconds) || stepPollSeconds < 1 || stepPollSeconds > 30) {
    toast("按钮检查间隔需要在 1–30 秒之间", { kind: "error" });
    return;
  }
  if (!Number.isFinite(stepWaitSeconds) || stepWaitSeconds < 5 || stepWaitSeconds > 300) {
    toast("等按钮的时间需要在 5–300 秒之间", { kind: "error" });
    return;
  }

  const body = {
    timezone,
    pollSeconds,
    triggerEnabled: checked("triggerEnabled"),
    controlChat: read("controlChat").trim() || "self",
    adminUserId: read("adminUserId").trim(),
    defaultTarget: read("defaultTarget").trim(),
    stepPollSeconds,
    stepWaitSeconds,
    triggerPrefix: read("triggerPrefix").trim(),
    notifyOnFailure: checked("notifyOnFailure"),
    ...(read("notifyWebhookKind") === "generic" || !read("notifyWebhookKind")
      ? { notifyWebhook: read("notifyWebhook").trim() }
      : { notifyWebhookToken: read("notifyWebhookToken").trim() }),
    notifyWebhookKind: read("notifyWebhookKind") || "generic",
    notifyEvents: [...form.querySelectorAll('input[name="notifyEvents"]:checked')].map((node) => node.value),
    digestHour: Number(read("digestHour") || 22),
    digestWeekday: Number(read("digestWeekday") || 0),
    weeklyHour: Number(read("weeklyHour") || 22),
    storageWarnPercent: Number(read("storageWarnPercent") || 0),
    successRateThreshold: Number(read("successRateThreshold") || 0),
    turnstileSiteKey: read("turnstileSiteKey").trim(),
  };
  // 密钥留空表示"不修改"，填了才提交；勾选「清除」则显式清空
  const turnstileSecret = read("turnstileSecretKey").trim();
  if (turnstileSecret) body.turnstileSecretKey = turnstileSecret;
  if (checked("clearTurnstileSecret")) body.clearTurnstileSecret = true;
  const webhookSecret = read("notifyWebhookSecret").trim();
  if (webhookSecret) body.notifyWebhookSecret = webhookSecret;
  if (checked("clearNotifyWebhookSecret")) body.clearNotifyWebhookSecret = true;

  await withLoading(form.querySelector('[type="submit"]'), async () => {
    try {
      await api("/api/settings", { method: "POST", body });
      form.dataset.dirty = "";
      // 让下一次进登录页时重新读 site key
      state.turnstileSiteKey = null;
      state.turnstileWidget = null;
      if (state.session) delete state.session.turnstileSiteKey;
      toast("设置已保存", { kind: "ok" });
      await refreshState({ silent: true });
      paint({ force: true });
    } catch (error) {
      toast(error.message || "保存失败", { kind: "error" });
    }
  });
}

/** 试算输入框下方的示例文案（只是输入提示，不是数据）。 */
const PARSE_EXAMPLES = [
  "9.30 签到",
  "每30分 签到 btn:立即签到 #kw:签到成功|已签到",
  "9.30-10.30 rand:早安|晚上好 #jitter:120 @jerry_bot",
];

function testerCard() {
  const textarea = el("textarea", {
    class: "textarea code-input",
    id: "dsl-test",
    rows: "2",
    placeholder: "9.30 签到 btn:立即签到 #kw:签到成功",
    spellcheck: "false",
    oninput: (event) => {
      state.testText = event.target.value;
    },
  });
  textarea.value = state.testText || "";

  return card({
    title: "指令试算",
    description: "输入一条指令，预览会解析成什么任务。",
    actions: [
      btn("查一下", {
        variant: "primary",
        iconName: "arrowRight",
        onClick: () => runParse(),
        id: "dsl-parse-btn",
      }),
    ],
    body: el(
      "div",
      { class: "tester" },
      el(
        "div",
        { class: "field" },
        el("label", { class: "field-label", for: "dsl-test" }, "指令内容"),
        textarea,
      ),
      el(
        "div",
        { class: "chips" },
        PARSE_EXAMPLES.map((text) =>
          el(
            "button",
            {
              class: "chip chip-button",
              type: "button",
              onclick: () => {
                state.testText = text;
                const node = document.getElementById("dsl-test");
                if (node) node.value = text;
                runParse();
              },
            },
            text,
          ),
        ),
      ),
      el("div", { class: "parse-out", id: "parse-out" }, renderParseResult()),
    ),
  });
}

function renderParseResult() {
  const result = state.parse;
  if (!result) {
    return el("p", { class: "muted small" }, "解析结果会显示在这里：时间、动作、目标和修饰符。");
  }
  if (result.ok === false) {
    return el(
      "div",
      { class: "banner banner-fail" },
      icon("alert", { size: 15 }),
      el("div", { class: "banner-text" }, result.error || "解析失败"),
    );
  }
  const task = result.task || {};
  const schedule = describeSchedule(task.schedule);
  const steps = Array.isArray(task.steps) ? task.steps : [];
  return el(
    "div",
    { class: "parse-card" },
    result.explanation ? el("p", { class: "parse-explain" }, result.explanation) : null,
    kv("时间", schedule),
    kv("目标", targetLabel(task.target)),
    kv(
      "动作",
      steps.length
        ? el(
            "span",
            { class: "chips" },
            steps.map((step) => el("span", { class: "chip" }, stepSummary(step))),
          )
        : el("span", { class: "muted" }, "无动作"),
    ),
    kv(
      "修饰符",
      el(
        "span",
        { class: "chips" },
        (task.successKeywords || []).length
          ? el("span", { class: "chip" }, `#kw ${(task.successKeywords || []).join("|")}`)
          : null,
        Number(task.schedule && task.schedule.jitterSeconds) > 0
          ? el("span", { class: "chip" }, `#jitter ${task.schedule.jitterSeconds}s`)
          : null,
        task.schedule && task.schedule.kind === "once" ? el("span", { class: "chip" }, "#once") : null,
        !(task.successKeywords || []).length && !(Number(task.schedule && task.schedule.jitterSeconds) > 0)
          ? el("span", { class: "muted" }, "无")
          : null,
      ),
    ),
    el(
      "div",
      { class: "parse-actions" },
      el(
        "button",
        {
          class: "btn btn-sm btn-primary",
          type: "button",
          onclick: async (event) => {
            await withLoading(event.currentTarget, async () => {
              try {
                const created = await api("/api/tasks", { method: "POST", body: task });
                toast(`已创建任务 #${created.task.id}`, { kind: "ok" });
                await refreshState({ silent: true });
              } catch (error) {
                toast(error.message || "创建失败（可能已存在相同任务）", { kind: "error" });
              }
            });
          },
        },
        "用这条指令建任务",
      ),
      el(
        "button",
        {
          class: "btn btn-sm",
          type: "button",
          onclick: () => copyText(state.testText || "", "指令已复制"),
        },
        "复制指令",
      ),
    ),
  );
}

async function runParse() {
  const text = String(state.testText || "").trim();
  if (!text) {
    toast("先输入一条指令", { kind: "error" });
    const node = document.getElementById("dsl-test");
    if (node) node.focus();
    return;
  }
  const button = document.getElementById("dsl-parse-btn");
  const task = async () => {
    try {
      const res = await api("/api/trigger/parse", { method: "POST", body: { text } });
      state.parse = res && typeof res === "object" ? res : { ok: false, error: "没有拿到结果，请再试一次" };
    } catch (error) {
      state.parse = { ok: false, error: error.message || "解析失败" };
    }
    // 只刷新结果区，避免把还没保存的设置表单冲掉
    const out = document.getElementById("parse-out");
    if (out) out.replaceChildren(renderParseResult());
    else paint({ force: true });
  };
  if (button) await withLoading(button, task);
  else await task();
}

function triggerHelp() {
  return el(
    "section",
    { class: "card help-card", id: "trigger-help" },
    el(
      "header",
      { class: "card-head" },
      el(
        "div",
        { class: "card-head-text" },
        el("h2", { class: "card-title" }, "指令写法"),
        el(
          "p",
          { class: "card-desc" },
          "在收藏夹（或设置里的「指令来源」）里发一条消息，就能创建和管理任务。",
        ),
      ),
    ),
    el(
      "div",
      { class: "card-body" },
      el("div", { class: "dsl-syntax" }, el("code", {}, "[时间] [动作...] [#修饰符]")),
      el(
        "div",
        { class: "help-grid" },
        helpBlock("时间", [
          ["9.30 / 09:30 / 21:05", "每天固定时间"],
          ["9.30-10.30", "窗口内随机一次"],
          ["每30分 / 每2小时", "周期循环"],
        ]),
        helpBlock("动作", [
          ["签到", "发送普通文本；带空格用引号"],
          ["btn:立即签到", "按按钮文本点击"],
          ["btn:0,1", "按行列点击（从 0 开始）"],
          ["num:1", "发送数字"],
          ["wait:5", "等待 5 秒"],
          ["rand:早安|晚上好", "随机发一条"],
        ]),
        helpBlock("修饰符", [
          ["#kw:签到成功|已签到", "成功关键词，任一命中即算成功"],
          ["#jitter:120", "执行前随机延迟最多 120 秒"],
          ["@jerry_bot", "指定目标账号 / 群组"],
          ["#once", "只执行一次"],
        ]),
        helpBlock("命令", [
          ["列表", "查看所有任务及编号"],
          ["立即 1", "立即执行任务 #1"],
          ["开启 1 / 关闭 1", "启用 / 停用任务"],
          ["删除 1", "删除任务"],
          ["帮助", "回复一份用法说明"],
        ]),
      ),
      el(
        "div",
        { class: "help-foot" },
        el("h3", { class: "help-foot-title" }, "目标识别顺序"),
        el(
          "ol",
          { class: "ordered" },
          el("li", {}, "消息文本里的 @target / t.me 链接"),
          el("li", {}, "转发 / 分享来源的会话"),
          el("li", {}, "被回复那条消息的发送者（回复机器人消息即可）"),
          el("li", {}, "设置里的 defaultTarget"),
        ),
      ),
    ),
  );
}

function helpBlock(title, rows) {
  return el(
    "div",
    { class: "help-block" },
    el("h3", { class: "help-title" }, title),
    el(
      "dl",
      { class: "help-list" },
      rows.map(([code, desc]) => el("div", { class: "help-row" }, el("dt", {}, el("code", {}, code)), el("dd", {}, desc))),
    ),
  );
}

/* ------------------------------------------------------------ 通用组件 */

function pageHead({ title, description, actions = [] }) {
  return el(
    "div",
    { class: "page-head" },
    el(
      "div",
      { class: "page-head-text" },
      el("h1", { class: "page-title" }, title),
      description ? el("p", { class: "page-desc" }, description) : null,
    ),
    actions.length ? el("div", { class: "page-actions" }, actions) : null,
  );
}

function btn(label, { variant = "ghost", iconName, onClick, title, className = "", id, type = "button" } = {}) {
  const node = el("button", {
    class: `btn btn-${variant}${className ? ` ${className}` : ""}`,
    type,
    title,
    id,
    "aria-label": title,
    onclick: onClick,
  });
  if (iconName) node.append(icon(iconName, { size: 15 }));
  if (label) node.append(el("span", {}, label));
  return node;
}

function card({ title, description, actions = [], body, className = "", id }) {
  const head = title
    ? el(
        "header",
        { class: "card-head" },
        el(
          "div",
          { class: "card-head-text" },
          el("h2", { class: "card-title" }, title),
          description ? el("p", { class: "card-desc" }, description) : null,
        ),
        actions.length ? el("div", { class: "card-actions" }, actions) : null,
      )
    : null;
  return el("section", { class: `card${className ? ` ${className}` : ""}`, id }, head, el("div", { class: "card-body" }, body));
}

function banner(kind, text) {
  const iconName = kind === "fail" || kind === "warn" ? "alert" : "info";
  return el(
    "div",
    { class: `banner banner-${kind}`, role: "status" },
    icon(iconName, { size: 15 }),
    el("div", { class: "banner-text" }, text),
  );
}

/** 关于里的用量面板（只统计次数，不采集内容） */
function usagePanel() {
  const events = (state.data && state.data.events) || null;
  if (!events) return el("div", { class: "about-build" }, "用量统计：暂无");

  const created = events.tasksCreated || { ui: 0, trigger: 0 };
  const runs = events.runs || { ok: 0, fail: 0 };
  const totalCreated = created.ui + created.trigger;
  const share = totalCreated ? Math.round((created.trigger / totalCreated) * 100) : 0;

  const item = (label, value, hint) =>
    el(
      "div",
      { class: "usage-item" },
      el("div", { class: "usage-value num" }, value),
      el("div", { class: "usage-label" }, label),
      hint ? el("div", { class: "usage-hint" }, hint) : null,
    );

  const trend = Array.isArray(events.trend) ? events.trend : [];
  const peak = Math.max(1, ...trend.map((item) => item.ok + item.fail));

  const chart = trend.length
    ? el(
        "div",
        { class: "usage-trend" },
        ...trend.map((item) =>
          el(
            "div",
            { class: "usage-trend-col", title: `${item.date}：成功 ${item.ok} · 失败 ${item.fail}` },
            el(
              "div",
              { class: "usage-trend-bar" },
              el("span", { class: "usage-trend-ok", style: `height:${Math.round((item.ok / peak) * 100)}%` }),
              el("span", { class: "usage-trend-fail", style: `height:${Math.round((item.fail / peak) * 100)}%` }),
            ),
            el("div", { class: "usage-trend-label" }, item.date),
          ),
        ),
      )
    : null;

  return el(
    "div",
    { class: "stack-sm" },
    chart,
    el(
    "div",
    { class: "usage-grid" },
    item("首次登录", events.firstLoginAt ? formatDateTime(events.firstLoginAt) : "—", null),
    item("任务", String(totalCreated), totalCreated ? `指令建 ${share}%` : "还没有任务"),
    item("执行", String(runs.ok + runs.fail), `成功 ${runs.ok} · 失败 ${runs.fail}`),
    item("故障已处理", String(events.failureHandled || 0), null),
    (() => {
      const storage = (state.data && state.data.runtime && state.data.runtime.storage) || null;
      if (!storage) return null;
      const mb = storage.bytes / (1024 * 1024);
      const used = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(storage.bytes / 1024))} KB`;
      return item("存储占用", used, `${storage.percent}% · 上限约 ${Math.round(storage.limitBytes / 1024 ** 3)} GB`);
    })(),
    ),
  );
}

/** 关于里的用量统计（纯文本版，保留给别处用） */
function usageSummary() {
  const events = (state.data && state.data.events) || null;
  if (!events) return "用量统计：暂无";
  const created = events.tasksCreated || { ui: 0, trigger: 0 };
  const runs = events.runs || { ok: 0, fail: 0 };
  const totalCreated = created.ui + created.trigger;
  const share = totalCreated ? Math.round((created.trigger / totalCreated) * 100) : 0;
  const firstLogin = events.firstLoginAt ? formatDateTime(events.firstLoginAt) : "未登录过";
  return `首次登录 ${firstLogin} · 任务 ${totalCreated} 个（指令 ${share}%）· 执行 ${runs.ok + runs.fail} 次（失败 ${runs.fail}）· 故障已处理 ${events.failureHandled || 0} 次`;
}

function kv(label, value) {
  return el("div", { class: "kv" }, el("span", { class: "kv-label" }, label), el("span", { class: "kv-value" }, value));
}

function controlChatLabel(settings) {
  const chat = settings && settings.controlChat;
  if (!chat || chat === "self") return "收藏夹";
  return String(chat);
}

/* ---------------------------------------------------------------- 启动 */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
