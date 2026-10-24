/**
 * 通知类型目录（唯一来源）。
 *
 * 这里是「哪些事件可以通知」的定义，服务端校验和前端选项都读它
 * （前端通过 /api/state 的 notifyCatalog 拿到，避免两边各写一份对不上）。
 */

export const NOTIFY_EVENT_IDS = [
  "run_failed",
  "run_success",
  "run_recovered",
  "auto_paused",
  "connection_error",
  "session_expired",
  "login_failed",
  "daily_digest",
] as const;

export type NotifyEventId = (typeof NOTIFY_EVENT_IDS)[number];

export interface NotifyEventMeta {
  id: NotifyEventId;
  label: string;
  hint: string;
  /** 默认为开：用户不改设置也能收到最关键的那几条 */
  defaultOn?: boolean;
  /** 会被节流成「同类 1 小时内最多一条」 */
  throttled?: boolean;
}

export const NOTIFY_EVENTS: NotifyEventMeta[] = [
  {
    id: "run_failed",
    label: "执行失败",
    hint: "某个任务跑失败了（同一任务 1 小时内最多一条）",
    defaultOn: true,
    throttled: true,
  },
  {
    id: "auto_paused",
    label: "连续失败自动暂停",
    hint: "连续失败达到阈值、任务被自动停用时",
    defaultOn: true,
  },
  {
    id: "run_recovered",
    label: "失败后恢复",
    hint: "之前连续失败、这次终于成功时（只在恢复那一次发）",
  },
  {
    id: "session_expired",
    label: "会话过期",
    hint: "Telegram 登录失效，需要到「账号」页重新登录",
    defaultOn: true,
    throttled: true,
  },
  {
    id: "connection_error",
    label: "连接异常",
    hint: "连不上 Telegram（网络/机房问题），整批任务都没跑成",
    defaultOn: true,
    throttled: true,
  },
  {
    id: "login_failed",
    label: "登录失败",
    hint: "有人多次输错管理界面口令（被临时锁定时提醒，1 小时最多一次）",
    throttled: true,
  },
  {
    id: "run_success",
    label: "执行成功",
    hint: "每次任务成功都提醒（任务多的话会很吵，默认关闭）",
  },
  {
    id: "daily_digest",
    label: "日报",
    hint: "每天固定时间汇总当天成功/失败次数与失败任务",
    defaultOn: true,
  },
];

export function isNotifyEventId(value: unknown): value is NotifyEventId {
  return typeof value === "string" && (NOTIFY_EVENT_IDS as readonly string[]).includes(value);
}

/** 默认开启的那些（老部署升级上来也能收到最关键的通知） */
export function defaultNotifyEvents(): NotifyEventId[] {
  return NOTIFY_EVENTS.filter((item) => item.defaultOn).map((item) => item.id);
}

/** 规范化用户传入的数组：只留认识的 id，去重，保持目录顺序 */
export function normalizeNotifyEvents(value: unknown): NotifyEventId[] {
  const source = Array.isArray(value) ? value : [];
  const chosen = new Set(source.filter(isNotifyEventId));
  return NOTIFY_EVENTS.filter((item) => chosen.has(item.id)).map((item) => item.id);
}

export function notifyEventMeta(id: NotifyEventId): NotifyEventMeta {
  return NOTIFY_EVENTS.find((item) => item.id === id) ?? NOTIFY_EVENTS[0];
}

/** 某个事件是否需要在推送前做「同类节流」 */
export function isThrottledEvent(id: NotifyEventId): boolean {
  return Boolean(notifyEventMeta(id).throttled);
}
