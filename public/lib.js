/**
 * lib.js — 通用工具：DOM 构建、内联图标、API 封装、时间/调度格式化、toast、弹窗。
 * 纯前端，无外部依赖，无 mock 数据。
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/* ------------------------------------------------------------------ DOM */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key === "html") node.innerHTML = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  appendChildren(node, children);
  return node;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  appendChildren(f, children);
  return f;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === "") continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

/* ---------------------------------------------------------------- 图标 */

const ICON_PATHS = {
  play: ["M9 6.6v10.8L18.5 12z"],
  power: ["M12 4v8", "M7.6 6.4a7 7 0 1 0 8.8 0"],
  pencil: ["M4.5 19.5h3.2L19 8.2a2.1 2.1 0 0 0-3-3L4.5 16.5v3z", "M14.8 6.2l3 3"],
  trash: ["M4.5 7h15", "M9.5 7V5.2h5V7", "M6.6 7l.9 12.3h9l.9-12.3"],
  plus: ["M12 5.5v13", "M5.5 12h13"],
  refresh: [
    "M3.5 12a8.5 8.5 0 0 1 14.6-5.9L21 8.5",
    "M21 3.8v4.7h-4.7",
    "M20.5 12a8.5 8.5 0 0 1-14.6 5.9L3 15.5",
    "M3 20.2v-4.7h4.7",
  ],
  x: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],
  chevron: ["M6.5 9.5l5.5 5.5 5.5-5.5"],
  up: ["M12 19V5", "M6.5 10.5L12 5l5.5 5.5"],
  down: ["M12 5v14", "M17.5 13.5L12 19l-5.5-5.5"],
  arrowRight: ["M4.5 12h14", "M13 6.5l5.5 5.5-5.5 5.5"],
  check: ["M5 12.5l4.5 4.5L19.5 6.5"],
  alert: ["M12 4.5l8.5 15h-17z", "M12 10v4.2", "M12 17.3v.01"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v5.2", "M12 7.9v.01"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7.5V12l3 1.8"],
  logout: ["M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3", "M10 8.5L6 12l4 3.5", "M6 12h9"],
  list: ["M4.5 7h15", "M4.5 12h15", "M4.5 17h9"],
  target: [
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
    "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z",
    "M12 13.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z",
  ],
  bolt: ["M13.5 3.5L6 13.5h5l-1 7 7.5-10h-5z"],
  terminal: ["M4.5 6.5l4.5 5.5-4.5 5.5", "M11 17.5h8"],
  copy: ["M9 9h9.5v9.5H9z", "M6 15H4.5V4.5H15V6"],
  download: ["M12 4v11", "M7.5 10.5L12 15l4.5-4.5", "M4.5 19.5h15"],
  upload: ["M12 15V4", "M7.5 8.5L12 4l4.5 4.5", "M4.5 19.5h15"],
};

export function icon(name, { size = 16, className = "" } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (className) svg.setAttribute("class", className);
  for (const d of ICON_PATHS[name] || []) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/* ----------------------------------------------------------------- API */

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

let unauthorizedHandler = null;

/** 注册 401 回调（回到登录页）。传入 null 可清除。 */
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

/**
 * fetch 封装：JSON in / JSON out，统一错误信息，401 时触发全局回调。
 * @param {string} path
 * @param {{method?: string, body?: unknown, auth?: boolean}} [options]
 */
export async function api(path, { method = "GET", body, auth = true } = {}) {
  const init = {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("网络请求失败，无法连接到服务端", 0, null);
  }

  let data = null;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    data = await res.json().catch(() => null);
  } else {
    const text = await res.text().catch(() => "");
    data = text ? { error: text.slice(0, 300) } : null;
  }

  if (res.status === 401) {
    if (auth && typeof unauthorizedHandler === "function") unauthorizedHandler();
    throw new ApiError((data && data.error) || "未登录或登录已过期", 401, data);
  }
  if (!res.ok) {
    throw new ApiError((data && data.error) || `请求失败（HTTP ${res.status}）`, res.status, data);
  }
  return data ?? {};
}

/* --------------------------------------------------------------- 时间 */

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * 时间戳归一化：接口约定是毫秒，但为了兼容「秒级」返回值，
 * 小于 1e12 的数字按秒处理。
 */
export function toMillis(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

let serverOffset = 0;

/** 用服务端 now 校正本地时钟。 */
export function setServerNow(ts) {
  const ms = toMillis(ts);
  if (ms > 0) serverOffset = Date.now() - ms;
}

/** 校正后的“现在”。 */
export function serverNow() {
  return Date.now() - serverOffset;
}

export function formatClock(ts = serverNow()) {
  const d = new Date(toMillis(ts) || Date.now());
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatDateTime(ts) {
  const ms = toMillis(ts);
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatFullTime(ts) {
  const ms = toMillis(ts);
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes(),
  )}:${pad2(d.getSeconds())}`;
}

export function formatRelative(ts, now = serverNow()) {
  const ms = toMillis(ts);
  if (!ms) return "—";
  const diff = now - ms;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const units = [
    [86400000, "天"],
    [3600000, "小时"],
    [60000, "分钟"],
  ];
  if (abs < 45000) return future ? "即将" : "刚刚";
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      return future ? `${n} ${label}后` : `${n} ${label}前`;
    }
  }
  return future ? "即将" : "刚刚";
}

export function formatCountdown(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "已到期";
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (days > 0) return `${days} 天 ${pad2(h)}:${pad2(m)}`;
  if (h > 0) return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

export function formatDurationWords(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "0 秒";
  if (s % 3600 === 0) return `${s / 3600} 小时`;
  if (s % 60 === 0) return `${s / 60} 分钟`;
  return `${s} 秒`;
}

/* --------------------------------------------------------- 任务文本化 */

export function describeSchedule(schedule) {
  const s = schedule || {};
  const jitter = Number(s.jitterSeconds) > 0 ? ` · 抖动 ≤${formatDurationWords(Number(s.jitterSeconds))}` : "";
  switch (s.kind) {
    case "daily":
      return `每天 ${s.time || "—"}${jitter}`;
    case "window":
      return `${s.time || "—"} – ${s.windowEnd || "—"} 内一次${jitter}`;
    case "interval":
      return `每 ${s.intervalMinutes || "—"} 分钟${jitter}`;
    case "once":
      return `一次 · ${s.time || "—"}${jitter}`;
    default:
      return s.kind ? String(s.kind) : "—";
  }
}

export function stepSummary(step) {
  if (!step) return "—";
  switch (step.type) {
    case "text":
      return `文本「${truncate(step.text, 14)}」`;
    case "random":
      return `随机 ${Array.isArray(step.options) ? step.options.length : 0} 选 1`;
    case "click":
      return step.text ? `点击「${truncate(step.text, 14)}」` : `点击 [${step.row ?? "?"},${step.column ?? "?"}]`;
    case "number":
      return `数字 ${step.value ?? "—"}`;
    case "wait":
      return `等待 ${step.seconds ?? "—"}s`;
    default:
      return String(step.type || "—");
  }
}

export function describeSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return "无动作";
  return steps.map(stepSummary).join(" → ");
}

/** 目标类型的显示文案与短标记（机器人 / 群组 / 频道 / 用户） */
export const PEER_KIND_LABEL = {
  bot: "机器人",
  group: "群组",
  channel: "频道",
  user: "用户",
};

export function peerKindLabel(peerKind) {
  return PEER_KIND_LABEL[peerKind] || "";
}

export function targetLabel(target) {
  if (!target) return "—";
  const handle = target.username ? `@${target.username}` : "";
  // 历史数据里 title 可能是 "@username" 的形式，避免和 handle 重复显示
  const rawTitle = target.title ? String(target.title) : "";
  const title = rawTitle && rawTitle.replace(/^@/, "") !== target.username ? rawTitle : "";
  if (title) return handle ? `${title} · ${handle}` : title;
  if (handle) return handle;
  if (target.id) return String(target.id);
  return "—";
}

export function truncate(value, max = 40) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/* --------------------------------------------------------------- Toast */

export function toast(message, { kind = "info", duration = 4200 } = {}) {
  const region = document.getElementById("toast-region");
  if (!region) return;
  const iconName = kind === "error" ? "alert" : kind === "ok" ? "check" : "info";
  const node = el(
    "div",
    { class: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status" },
    icon(iconName, { size: 15 }),
    el("div", { class: "toast-text" }, String(message ?? "")),
  );
  region.append(node);
  const timer = setTimeout(() => {
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 200);
  }, duration);
  node.addEventListener("click", () => {
    clearTimeout(timer);
    node.remove();
  });
  while (region.children.length > 4) region.firstElementChild.remove();
}

/* ------------------------------------------------------------- 弹窗 */

let modalState = null;
let overlayBound = false;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function bindOverlayOnce() {
  if (overlayBound) return;
  overlayBound = true;
  const overlay = document.getElementById("overlay");
  if (!overlay) return;
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (!modalState) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = document.getElementById("dialog");
    if (!dialog) return;
    const items = Array.from(dialog.querySelectorAll(FOCUSABLE)).filter(
      (node) => node.offsetParent !== null || node === document.activeElement,
    );
    if (items.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

/**
 * 打开弹窗。全局只用弹窗，不再有抽屉（variant 参数已移除）。
 * @param {{title: string, body: Node, footer?: Node|null, size?: "md"|"lg", onClose?: Function}} options
 *   size: "md" 默认 540px；"lg" 760px（表单类内容，如任务编辑器）
 */
export function openModal({ title, body, footer = null, size = "md", onClose }) {
  bindOverlayOnce();
  if (modalState) closeModal(true);

  const overlay = document.getElementById("overlay");
  const dialog = document.getElementById("dialog");
  if (!overlay || !dialog) return null;

  const restoreFocus = document.activeElement;
  dialog.className = size === "lg" ? "dialog dialog-wide" : "dialog";
  dialog.innerHTML = "";
  dialog.setAttribute("tabindex", "-1");

  const titleId = "dialog-title";
  const head = el(
    "div",
    { class: "dialog-head" },
    el("h2", { class: "dialog-title", id: titleId }, title),
    el(
      "button",
      { class: "btn btn-icon", type: "button", "aria-label": "关闭", onclick: () => closeModal() },
      icon("x", { size: 16 }),
    ),
  );
  const bodyWrap = el("div", { class: "dialog-body" }, body);
  dialog.append(head, bodyWrap);
  if (footer) dialog.append(el("div", { class: "dialog-foot" }, footer));
  dialog.setAttribute("aria-labelledby", titleId);

  overlay.hidden = false;
  document.body.classList.add("is-locked");
  modalState = { restoreFocus, onClose };

  requestAnimationFrame(() => {
    const items = dialog.querySelectorAll(FOCUSABLE);
    const autofocus = dialog.querySelector("[data-autofocus]");
    if (autofocus instanceof HTMLElement) autofocus.focus();
    else if (items.length > 0) items[0].focus();
    else dialog.focus();
  });

  return { dialog, body: bodyWrap, close: () => closeModal() };
}

export function closeModal(inside = false) {
  const state = modalState;
  if (!state) return;
  modalState = null;
  const overlay = document.getElementById("overlay");
  const dialog = document.getElementById("dialog");
  if (overlay) overlay.hidden = true;
  if (dialog) dialog.innerHTML = "";
  document.body.classList.remove("is-locked");
  if (state.restoreFocus instanceof HTMLElement && document.contains(state.restoreFocus)) {
    state.restoreFocus.focus();
  }
  if (!inside && typeof state.onClose === "function") state.onClose();
}

/** 二次确认，返回 Promise<boolean>。 */
export function confirmDialog({
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const footer = el(
      "div",
      { class: "dialog-actions" },
      el("button", { class: "btn", type: "button", onclick: () => { done(false); closeModal(); } }, cancelLabel),
      el(
        "button",
        {
          class: danger ? "btn btn-danger" : "btn btn-primary",
          type: "button",
          onclick: () => { done(true); closeModal(); },
        },
        confirmLabel,
      ),
    );
    openModal({
      title,
      body: el("p", { class: "dialog-text" }, message),
      footer,
      onClose: () => done(false),
    });
    requestAnimationFrame(() => {
      const btn = document.querySelector("#dialog .dialog-foot button:last-child");
      if (btn instanceof HTMLElement) btn.focus();
    });
  });
}

/* ------------------------------------------------------------ 按钮状态 */

/** 给按钮加 loading 态（禁用 + spinner），执行完恢复。 */
export async function withLoading(button, task) {
  if (!(button instanceof HTMLElement)) return task();
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.dataset.loading = "1";
  button.setAttribute("aria-busy", "true");
  const spinner = el("span", { class: "spinner", "aria-hidden": "true" });
  button.prepend(spinner);
  try {
    return await task();
  } finally {
    spinner.remove();
    delete button.dataset.loading;
    button.removeAttribute("aria-busy");
    button.disabled = wasDisabled;
  }
}

/** 只读按钮：普通按钮 + 图标。 */
export function iconButton(name, label, onClick, { className = "", size = 15 } = {}) {
  return el(
    "button",
    {
      class: `btn btn-icon${className ? ` ${className}` : ""}`,
      type: "button",
      // data-tip 给 CSS 做即时悬浮提示；title 留作读屏与原生兜底
      title: label,
      "data-tip": label,
      "aria-label": label,
      onclick: onClick,
    },
    icon(name, { size }),
  );
}

/** 空状态占位。 */
export function emptyState({ iconName = "list", title, text, actions = [] } = {}) {
  return el(
    "div",
    { class: "empty" },
    el("span", { class: "empty-icon" }, icon(iconName, { size: 18 })),
    el("p", { class: "empty-title" }, title),
    text ? el("p", { class: "empty-text" }, text) : null,
    actions.length ? el("div", { class: "empty-actions" }, actions) : null,
  );
}

/** 表单字段包装：label + 控件 + 说明。 */
export function field({ id, label, control, hint, className = "" }) {
  return el(
    "div",
    { class: `field${className ? ` ${className}` : ""}` },
    el("label", { class: "field-label", for: id }, label),
    control,
    hint ? el("p", { class: "field-hint" }, hint) : null,
  );
}
