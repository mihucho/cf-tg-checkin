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
  logsNextBefore: null, // 「加载更多」游标（比页码稳：新日志插入不会跳行）
  turnstileToken: "", // Turnstile 通过后拿到的 token（登录时提交）
  turnstileWidget: null, // widget id，用于 reset
  turnstileSiteKey: null,
  logLevel: "", // "" | "ok" | "fail"
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
  if (!account || !account.signedIn || !account.me) return "未登录 TG";
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
    description: "签到任务的运行状态一览。",
    actions: [
      btn("运行全部", { iconName: "bolt", onClick: (event) => runAll(event.currentTarget) }),
      btn("检查调度", {
        variant: "subtle",
        iconName: "refresh",
        onClick: (event) => runTick(event.currentTarget),
      }),
    ],
  });

  const runtime = (state.data && state.data.runtime) || {};
  const mtproto = !account.signedIn
    ? { dot: "fail", text: "未登录" }
    : account.connected
      ? { dot: "ok", text: "已连接" }
      : { dot: "idle", text: "空闲（按需连接）" };

  const grid = el(
    "div",
    { class: "stat-grid" },
    statCard({
      label: "MTProto 连接",
      dot: mtproto.dot,
      value: mtproto.text,
      foot: account.signedIn
        ? el("span", {}, account.me ? targetLabel({ ...account.me, title: account.me.firstName }) : "已保存登录状态")
        : el("a", { class: "link", href: "#/account" }, "现在登录 Telegram"),
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
      label: "触发器",
      dot: settings.triggerEnabled ? "ok" : "idle",
      value: settings.triggerEnabled ? "监听中" : "已停止",
      foot: `来源 ${controlChatLabel(settings)} · 每 ${Number(settings.pollSeconds) || 60} 秒轮询${
        runtime && runtime.nextPollAt ? `（下次 ${formatClock(runtime.nextPollAt)}）` : ""
      }`,
      sub:
        runtime && runtime.lastPollAt
          ? `上次轮询 ${formatRelative(runtime.lastPollAt)}` +
            (Date.now() - runtime.lastPollAt > Math.max(180_000, (Number(settings.pollSeconds) || 60) * 3000)
              ? " ⚠️ 已超时"
              : "")
          : "还没有轮询过（登录 Telegram 后开始）",
      sub2:
        runtime && runtime.lastTriggerEvent
          ? `最近事件：${runtime.lastTriggerEvent.ok ? "" : "⚠️ "}${runtime.lastTriggerEvent.message}（${formatRelative(
              runtime.lastTriggerEvent.at,
            )}）`
          : "最近事件：还没有处理过触发消息",
      sub: `步骤检测 ${Number(settings.stepPollSeconds) || 3}s / 最长 ${Number(settings.stepWaitSeconds) || 30}s`,
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
          el("p", { class: "empty-text" }, "运行一次任务，或直接在收藏夹发送触发消息。"),
        ),
  });

  return frag(
    header,
    account.lastError ? banner("warn", account.lastError) : null,
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
          el("h2", { class: "card-title" }, "触发器"),
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
              ? "监听中。支持点击按钮、随机文本、成功关键词等修饰符。"
              : "触发器已停止，可在设置里重新开启。",
          ),
          el("a", { class: "link link-sm", href: "#/settings" }, "查看 DSL 说明与试算", icon("arrowRight", { size: 14 })),
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

  const header = pageHead({
    title: "任务",
    description: tasks.length
      ? `${tasks.length} 个任务 · ${enabled} 个启用 · ${tasks.length - enabled} 个停用 · 立即执行只是手动跑一次，不改动下次定时`
      : "还没有任务，先建一个签到任务。",
    actions: tasks.length
      ? [btn("运行全部", { iconName: "bolt", onClick: (event) => runAll(event.currentTarget) }), newBtn]
      : [newBtn],
  });

  if (!tasks.length) {
    return frag(
      header,
      el(
        "div",
        { class: "card card-pad" },
        emptyState({
          iconName: "list",
          title: "还没有签到任务",
          text: "可以手动新建，也可以直接在收藏夹发一条「9.30 签到」让触发器帮你建。",
          actions: [
            newTaskBtn("ghost", "新建任务"),
            el("a", { class: "btn btn-subtle", href: "#/settings" }, "看看 DSL 写法"),
          ],
        }),
      ),
    );
  }

  return frag(header, el("div", { class: "card table-card" }, el("div", { class: "table-wrap" }, taskTable(tasks))));
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
    el("tbody", {}, tasks.map(taskRow)),
  );
}

function taskRow(task) {
  const target = task.target || {};
  const enabledText = task.enabled ? "已启用" : "已停用";
  const subParts = [`#${task.id}`];
  if (task.source === "trigger") subParts.push("触发器创建");
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
        el("span", { class: "task-name" }, task.name || `任务 #${task.id}`),
        task.source === "trigger" ? el("span", { class: "tag" }, "触发器") : null,
      ),
      el("div", { class: "cell-sub" }, subParts.join(" · ")),
    ),
    el(
      "td",
      { dataset: { label: "目标" } },
      el("div", { class: "cell-main cell-trunc", title: targetLabel(target) }, targetLabel(target)),
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
        { class: "row-actions" },
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
  if (!task.lastResult) return el("span", { class: "muted" }, "—");
  const ok = task.lastResult === "ok";
  return el(
    "div",
    { class: "result-cell" },
    el(
      "span",
      { class: `status ${ok ? "is-ok" : "is-fail"}`, title: task.lastMessage || "" },
      el("span", { class: `dot ${ok ? "ok" : "fail"}` }),
      el("span", {}, ok ? "成功" : "失败"),
    ),
    task.lastDetail
      ? el(
          "button",
          {
            class: "link link-sm result-detail-btn",
            type: "button",
            onclick: () => openRunDetail(task),
          },
          "步骤日志",
        )
      : null,
  );
}

/** 最后一次运行的逐步日志：弹窗里看，避免挤在表格单元格里 */
function openRunDetail(task) {
  const when = task.lastRunAt ? formatDateTime(task.lastRunAt) : "未知时间";
  const ok = task.lastResult === "ok";
  openModal({
    title: `最近一次运行 · ${task.name || `任务 #${task.id}`}`,
    body: el(
      "div",
      { class: "run-detail" },
      el(
        "div",
        { class: "run-detail-meta" },
        el("span", { class: `status ${ok ? "is-ok" : "is-fail"}` }, el("span", { class: `dot ${ok ? "ok" : "fail"}` }), el("span", {}, ok ? "成功" : "失败")),
        el("span", { class: "muted" }, `· ${when}`),
        el("span", { class: "muted" }, `· ${task.lastMessage || "无摘要"}`),
      ),
      el("pre", { class: "run-detail-body" }, task.lastDetail || "（这次运行没有步骤日志）"),
      el(
        "p",
        { class: "hint" },
        "完整历史在「日志」页；这里只保留最近一次运行的步骤。",
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
    message: `确定删除「${task.name}」？删除后无法恢复，历史日志会保留。`,
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
  await withLoading(button, async () => {
    try {
      const res = await api("/api/tasks/run-all", { method: "POST" });
      const logs = Array.isArray(res && res.logs) ? res.logs : [];
      const failed = logs.filter((log) => !log.ok).length;
      toast(
        logs.length
          ? `执行了 ${logs.length} 个任务${failed ? `，${failed} 个失败` : "，全部成功"}`
          : "没有可执行的任务",
        { kind: failed ? "error" : "ok" },
      );
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
      toast(ran ? `触发了 ${ran} 次执行` : "检查完成，暂无到期的任务", { kind: "ok" });
      await refreshState({ silent: true });
    } catch (error) {
      toast(error.message || "检查失败", { kind: "error" });
    }
  });
}

/* --------------------------------------------------------------- 日志 */

async function loadLogs({ silent = false, append = false } = {}) {
  try {
    const params = new URLSearchParams({ limit: "50" });
    if (state.logLevel) params.set("level", state.logLevel);
    if (append && state.logsNextBefore) params.set("before", String(state.logsNextBefore));
    const res = await api(`/api/logs?${params.toString()}`);
    const logs = Array.isArray(res && res.logs) ? res.logs : [];
    state.logs = append && Array.isArray(state.logs) ? [...state.logs, ...logs] : logs;
    state.logsNextBefore = res && res.nextBefore ? res.nextBefore : null;
  } catch (error) {
    if (!silent) toast(error.message || "读取日志失败", { kind: "error" });
  }
  if (state.view === "logs") paint({ force: true });
}

function renderLogs() {
  const logs = Array.isArray(state.logs)
    ? state.logs
    : Array.isArray(state.data.logs)
      ? state.data.logs
      : [];

  const header = pageHead({
    title: "日志",
    description: logs.length
      ? `已加载 ${logs.length} 条${state.logsNextBefore ? "（还有更早的）" : ""}，点击行可展开细节。服务端只保留最近 2000 条。`
      : "执行记录与错误细节。",
    actions: [
      btn("刷新", {
        iconName: "refresh",
        onClick: (event) => withLoading(event.currentTarget, () => loadLogs()),
      }),
      btn("清空日志", { iconName: "trash", className: "is-danger", onClick: clearLogs }),
    ],
  });

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
            state.logs = null;
            state.logsNextBefore = null;
            await withLoading(event.currentTarget, () => loadLogs(), { silent: true });
          },
        },
        label,
      ),
    ),
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
          text: "运行任务或发送触发消息后，结果会出现在这里。",
          actions: [el("a", { class: "btn", href: "#/tasks" }, "回到任务")],
        }),
      ),
    );
  }

  return frag(
    header,
    filters,
    el("div", { class: "card log-card" }, el("ul", { class: "log-list" }, logs.map(logItem))),
    state.logsNextBefore
      ? el(
          "div",
          { class: "log-more" },
          el(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: (event) => withLoading(event.currentTarget, () => loadLogs({ append: true })),
            },
            "加载更早的日志",
          ),
        )
      : null,
  );
}

function logItem(log) {
  const id = log && log.id;
  const at = toMillis(log && log.at);
  const hasDetail = Boolean(log && log.detail);
  const expanded = state.expandedLogs.has(id);
  const dotClass = log.ok ? "ok" : log.level === "warn" ? "warn" : "fail";
  const levelText = log.ok ? "成功" : log.level === "warn" ? "警告" : "失败";

  const detail = hasDetail
    ? el("pre", { class: "log-detail", hidden: !expanded }, String(log.detail))
    : null;

  const head = el(
    hasDetail ? "button" : "div",
    {
      class: `log-head${hasDetail ? " is-expandable" : ""}`,
      type: hasDetail ? "button" : undefined,
      "aria-expanded": hasDetail ? String(expanded) : undefined,
      onclick: hasDetail
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
      log.message || "(无消息)",
      log.ok ? null : el("span", { class: "log-level" }, levelText),
    ),
    el(
      "span",
      { class: "log-meta" },
      el("span", { class: "log-task" }, log.taskName || "系统"),
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
      hasDetail ? icon("chevron", { size: 14, className: "log-chevron" }) : null,
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
    description: "MTProto 凭据只保存在服务端，页面不会拿到 apiHash。",
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
    description: "用 my.telegram.org 的 API 凭据登录，三步完成。",
    body,
  });
}

function stepper(step) {
  const items = ["填写 API 凭据", "输入验证码", "两步验证密码"];
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
      "apiId 和 apiHash 在 ",
      el(
        "a",
        { class: "link", href: "https://my.telegram.org", target: "_blank", rel: "noopener noreferrer" },
        "my.telegram.org",
      ),
      " 的 API development tools 里申请。凭据只提交给服务端。",
    ),
    field({
      id: "account-api-id",
      label: "apiId",
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
      hint: "纯数字。",
    }),
    field({
      id: "account-api-hash",
      label: "apiHash",
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
  const phone = pending.phone || state.accountPhone || account.phone || "你的 Telegram";
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

  if (!Number.isFinite(apiId) || apiId <= 0) return setFormError(form, "apiId 需要是数字");
  if (!apiHash) return setFormError(form, "请填写 apiHash");
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
              ? "已连接（MTProto 会话活跃）"
              : account.lastConnectedAt
                ? `空闲（按需连接，上次成功连接 ${formatRelative(account.lastConnectedAt)}）`
                : "空闲（按需连接：收到任务或下次轮询时自动连上）",
          ),
          metaRow("用户 id", String(me.id ?? "—")),
          metaRow("手机号", account.phone ? maskPhone(account.phone) : "—"),
          metaRow("apiId", account.apiId ? String(account.apiId) : "—"),
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
    message: "会注销 MTProto 会话，定时任务在重新登录前将无法执行。",
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

function renderSettings() {
  const settings = (state.data && state.data.settings) || {};
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

  form.append(
    el(
      "div",
      { class: "form-row" },
      field({
        id: "settings-timezone",
        label: "时区偏移（小时）",
        control: numberControl("timezone", settings.timezone ?? 8, { step: "0.5", min: "-12", max: "14" }),
        hint: "东八区填 8；支持小数（如 5.5）。",
      }),
      field({
        id: "settings-pollSeconds",
        label: "触发器轮询间隔（秒）",
        control: numberControl("pollSeconds", settings.pollSeconds ?? 60, { step: "5", min: "15", max: "3600" }),
        hint: "越小越及时，但会消耗更多请求。",
      }),
    ),
    el("div", { class: "form-section-title" }, "步骤检测"),
    el(
      "div",
      { class: "form-row" },
      field({
        id: "settings-stepPollSeconds",
        label: "检测间隔（秒）",
        control: numberControl("stepPollSeconds", settings.stepPollSeconds ?? 3, {
          step: "1",
          min: "1",
          max: "30",
        }),
        hint: "等下一步按钮/回复时，每隔多久查一次消息。",
      }),
      field({
        id: "settings-stepWaitSeconds",
        label: "最多等待（秒）",
        control: numberControl("stepWaitSeconds", settings.stepWaitSeconds ?? 30, {
          step: "5",
          min: "5",
          max: "300",
        }),
        hint: "超过这个时间还没出现下一步，就记为失败。",
      }),
    ),
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-label" }, "触发器"),
      el(
        "label",
        { class: "switch" },
        el("input", {
          type: "checkbox",
          name: "triggerEnabled",
          checked: Boolean(settings.triggerEnabled),
        }),
        el("span", { class: "switch-track", "aria-hidden": "true" }),
        el("span", { class: "switch-text" }, "允许用 Telegram 消息管理任务"),
      ),
      el("p", { class: "field-hint" }, "关闭后不再监听新消息，已有的定时任务照常执行。"),
    ),
    field({
      id: "settings-controlChat",
      label: "触发消息来源（controlChat）",
      control: textControl("controlChat", settings.controlChat ?? "self", "self"),
      hint: "self 表示收藏夹（Saved Messages）；也可以填 @username 或数字 id。",
    }),
    field({
      id: "settings-adminUserId",
      label: "管理员 Telegram id（adminUserId）",
      control: textControl("adminUserId", settings.adminUserId ?? "", "", "numeric"),
      hint: "只有这个 id 能通过消息命令管理任务，留空表示不校验。",
    }),
    field({
      id: "settings-defaultTarget",
      label: "默认目标（defaultTarget）",
      control: textControl("defaultTarget", settings.defaultTarget ?? "", "@username 或数字 id"),
      hint: "触发消息里识别不到目标时使用，例如 @jerry_bot。",
    }),
    el("div", { class: "form-section-title" }, "登录人机验证（Cloudflare Turnstile）"),
    field({
      id: "settings-turnstileSiteKey",
      label: "站点 key（Site Key）",
      control: textControl("turnstileSiteKey", settings.turnstileSiteKey ?? "", "例如 0x4AAAAAAA…"),
      hint: "Cloudflare 控制台 → Turnstile → Add site 里获取。填了才会在登录页出现验证框。",
    }),
    field({
      id: "settings-turnstileSecret",
      label: "密钥（Secret Key）",
      control: el("input", {
        class: "input",
        id: "settings-turnstileSecret",
        name: "turnstileSecretKey",
        type: "password",
        autocomplete: "new-password",
        spellcheck: "false",
        placeholder: settings.turnstileSecretConfigured ? "已配置（留空表示不修改）" : "例如 0x4AAAAAAA…",
      }),
      hint: "只存在服务端，接口不会回传。留空保存 = 保持不变；要关闭验证请点下面的「清除」。",
    }),
    el(
      "div",
      { class: "check-row" },
      el("input", { type: "checkbox", id: "settings-clearTurnstile", name: "clearTurnstileSecret" }),
      el("label", { for: "settings-clearTurnstile" }, "清除已保存的密钥（关闭人机验证）"),
    ),
    el(
      "div",
      { class: "form-actions" },
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

  return frag(
    pageHead({ title: "设置", description: "调度、触发器与默认目标。" }),
    card({ title: "调度与触发器", description: "保存后立即生效。", body: form }),
    testerCard(),
    triggerHelp(),
    card({
      title: "关于",
      description: "部署排查时，把这一行发给维护者最快。",
      body: el(
        "div",
        { class: "stack-sm" },
        el("div", { class: "about-build", id: "about-build" }, state.build ? "" : "读取中…"),
        el(
          "div",
          { class: "about-build" },
          `出口机房 ${(state.data && state.data.runtime && state.data.runtime.colo) || "未记录"}` +
            (state.data && state.data.runtime && state.data.runtime.locationHint
              ? ` · DO 区域 ${state.data.runtime.locationHint}`
              : ""),
        ),
        el(
          "p",
          { class: "hint" },
          "管理界面是纯静态资源；版本号来自构建时注入的 git commit，可用 ",
          el("code", {}, "/api/version"),
          " 直接查看。",
        ),
      ),
    }),
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
    toast("轮询间隔需要在 15–3600 秒之间", { kind: "error" });
    return;
  }
  if (!Number.isFinite(stepPollSeconds) || stepPollSeconds < 1 || stepPollSeconds > 30) {
    toast("步骤检测间隔需要在 1–30 秒之间", { kind: "error" });
    return;
  }
  if (!Number.isFinite(stepWaitSeconds) || stepWaitSeconds < 5 || stepWaitSeconds > 300) {
    toast("步骤最多等待需要在 5–300 秒之间", { kind: "error" });
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
    turnstileSiteKey: read("turnstileSiteKey").trim(),
  };
  // 密钥留空表示"不修改"，填了才提交；勾选「清除」则显式清空
  const turnstileSecret = read("turnstileSecretKey").trim();
  if (turnstileSecret) body.turnstileSecretKey = turnstileSecret;
  if (checked("clearTurnstileSecret")) body.clearTurnstileSecret = true;

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
    title: "试算触发器",
    description: "把准备发送的消息贴进来，看看会解析成什么任务。",
    actions: [
      btn("解析", {
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
        el("label", { class: "field-label", for: "dsl-test" }, "触发消息"),
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
  );
}

async function runParse() {
  const text = String(state.testText || "").trim();
  if (!text) {
    toast("先输入一条触发消息", { kind: "error" });
    const node = document.getElementById("dsl-test");
    if (node) node.focus();
    return;
  }
  const button = document.getElementById("dsl-parse-btn");
  const task = async () => {
    try {
      const res = await api("/api/trigger/parse", { method: "POST", body: { text } });
      state.parse = res && typeof res === "object" ? res : { ok: false, error: "服务端返回了空结果" };
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
        el("h2", { class: "card-title" }, "触发器 DSL"),
        el(
          "p",
          { class: "card-desc" },
          "在收藏夹（或设置里的 controlChat）里发一条消息，就能创建和管理签到任务。",
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
          ["btn:0,1", "按行列点击（0 基）"],
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
