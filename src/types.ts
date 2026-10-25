/** 共享类型：前端契约见 docs/API.md */

export type StepType = "text" | "random" | "click" | "number" | "wait";

export interface Step {
  type: StepType;
  /** text 用 */
  text?: string;
  /** random 用 */
  options?: string[];
  /** click 按文本找按钮 */
  row?: number;
  column?: number;
  /** number 用 */
  value?: string;
  /** wait 用 */
  seconds?: number;
}

export type TargetKind = "user" | "chat" | "channel";

export interface Target {
  kind: TargetKind;
  /** 数字 id（字符串形式，保留 -100 前缀）或 @username */
  id: string;
  title?: string;
  username?: string;
  /** 目标实体的 access_hash（有它就不必"见过"对方也能解析） */
  accessHash?: string;
  /** 话题 id：只对这个目标生效，优先于任务的 threadId */
  threadId?: number;
  /**
   * 对方是什么：机器人 / 用户 / 群组 / 频道。
   * 解析目标时记下来，界面上标出来，也方便判断"该等它回复还是等新菜单"。
   */
  peerKind?: "bot" | "user" | "group" | "channel";
}

export type ScheduleKind = "daily" | "window" | "interval" | "once";

export interface Schedule {
  kind: ScheduleKind;
  /** HH:MM（daily / once / window 起点） */
  time?: string;
  /** HH:MM（window 终点） */
  windowEnd?: string;
  /** 间隔分钟数（interval） */
  intervalMinutes?: number;
  /** 执行前随机延迟（秒） */
  jitterSeconds?: number;
}

export type TaskSource = "ui" | "trigger";

export interface Task {
  id: number;
  name: string;
  /**
   * 任务名是不是系统自动生成的。
   * true  → 目标补全出显示名时，名字可以跟着改（「123456789 签到」→「示例机器人 签到」）
   * false → 用户自己起的名字，任何情况下都不动它
   * undefined（老数据）→ 只有名字仍等于系统默认名时才允许改
   */
  nameAuto?: boolean;
  enabled: boolean;
  /** 主目标（兼容老字段） */
  target: Target;
  /** 多目标：第一个与 target 相同；为空表示只有一个目标 */
  targets?: Target[];
  threadId: number | null;
  schedule: Schedule;
  steps: Step[];
  successKeywords: string[];
  timeoutSeconds: number;
  /** 每执行完一个动作后，等多久再做下一个动作（秒，默认 3） */
  stepDelaySeconds: number;
  deleteAfterSeconds: number;
  cleanupPrevious: boolean;
  /** 任务分组（自由文本，空 = 未分组）；列表按它折叠 */
  group?: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastResult: "ok" | "fail" | null;
  /** 连续失败次数（成功会清零；达到阈值自动暂停任务） */
  failStreak?: number;
  lastMessage: string | null;
  /** 最后一次运行的逐步日志（换行分隔，界面里可展开查看） */
  lastDetail?: string | null;
  source: TaskSource;
  createdAt: number;
  updatedAt: number;
}

export type TaskInput = Omit<
  Task,
  "id" | "nextRunAt" | "lastRunAt" | "lastResult" | "lastMessage" | "createdAt" | "updatedAt"
> &
  Partial<Pick<Task, "id" | "nextRunAt" | "lastRunAt" | "lastResult" | "lastMessage">>;

export type LogSource = "auto" | "manual" | "trigger" | "system";

export interface LogEntry {
  id: number;
  taskId: number | null;
  taskName: string | null;
  at: number;
  ok: boolean;
  level: "info" | "warn" | "error";
  message: string;
  detail: string | null;
  /** 这次执行是谁触发的（老数据可能没有） */
  source?: LogSource | null;
  /** 执行耗时（毫秒），只有执行类日志有 */
  durationMs?: number | null;
}

/** 用户自定义模板（存在服务端设置里，跨设备同步） */
export interface TaskTemplate {
  id: string;
  name: string;
  command: string;
}

export type WebhookKind = "generic" | "dingtalk" | "wecom" | "feishu";

export type { NotifyEventId } from "./notify/events";
import type { NotifyEventId } from "./notify/events";

export interface Settings {
  /** 时区偏移小时，可为小数（Asia/Shanghai = 8） */
  timezone: number;
  /** 触发消息轮询间隔（秒） */
  pollSeconds: number;
  triggerEnabled: boolean;
  /** self=收藏夹，或 @username / 数字 id */
  controlChat: string;
  adminUserId: string;
  defaultTarget: string;
  /** 等待下一步按钮/回复时，间隔多少秒检测一次（默认 3） */
  stepPollSeconds: number;
  /** 单次最多等待多少秒（默认 30） */
  stepWaitSeconds: number;
  /** 触发前缀：只有以它开头的消息才当配置解析（默认 "tg"；设成空字符串表示全部都解析） */
  triggerPrefix: string;
  /** 是否也在 Telegram 里提醒自己（私聊）；关闭后只有 Webhook */
  notifyOnFailure: boolean;
  /** 要通知的事件类型（见 NOTIFY_EVENTS；Webhook 与 Telegram 共用） */
  notifyEvents: NotifyEventId[];
  /** 日报发送时间（本地时区的小时，0-23） */
  digestHour: number;
  /** 周报发送日（0=周一 … 6=周日） */
  digestWeekday: number;
  /** 周报发送时间（本地时区小时，0-23） */
  weeklyHour: number;
  /** 存储告警阈值（占 DO 存储上限的百分比，0 = 关闭） */
  storageWarnPercent: number;
  /** 成功率告警阈值（百分比，0 = 关闭）。窗口固定最近 7 天、样本至少 3 次 */
  successRateThreshold: number;
  /** 可选：失败提醒推送到这个 Webhook */
  notifyWebhook: string;
  /** 推送渠道（手动选择）：钉钉 / 企业微信 / 飞书 / 通用 JSON */
  notifyWebhookKind: WebhookKind;
  /** 钉钉「加签」密钥：只存服务端，接口不回传（用 notifyWebhookSecretConfigured 表示有没有） */
  notifyWebhookSecret: string;
  /** 只读标记：接口返回时告知前端"加签密钥已配置" */
  notifyWebhookSecretConfigured?: boolean;
  /** 只读标记：接口返回时告知前端「Webhook 地址已配置」（地址本身已脱敏） */
  notifyWebhookConfigured?: boolean;
  /** 自定义模板（最多 20 个） */
  templates: TaskTemplate[];
  /** Turnstile 站点 key（公开，会下发前端） */
  turnstileSiteKey: string;
  /** Turnstile 密钥：只在服务端用，接口永远不回传（用 turnstileSecretConfigured 表示有没有） */
  turnstileSecretKey: string;
  /** 只读标记：接口返回时告知前端"密钥已配置" */
  turnstileSecretConfigured?: boolean;
}

export interface AccountInfo {
  configured: boolean;
  apiId: number | null;
  phone: string | null;
  signedIn: boolean;
  me: { id: string; username: string | null; firstName: string } | null;
  connected: boolean;
  /** 最近一次成功连接的时间（断开后用来显示"多久前连过"） */
  lastConnectedAt?: number | null;
  pendingLogin: { phone: string; stage: "code" | "password" } | null;
  /** Telegram 账号归属的数据中心（登录时探测到才会填） */
  dc?: number | null;
  lastError: string | null;
}

export interface AgentState {
  account: AccountInfo;
  settings: Settings;
  tasks: Task[];
  logs: LogEntry[];
  stats: {
    totalTasks: number;
    enabledTasks: number;
    nextRunAt: number | null;
    lastRunAt: number | null;
  };
  now: number;
  /** 最小埋点计数（只统计次数与时间，不采集内容） */
  /** 前端渲染「通知类型」多选用的目录（服务端是唯一来源） */
  notifyCatalog?: Array<{ id: string; label: string; hint: string; throttled: boolean }>;
  events?: {
    trend?: Array<{ date: string; ok: number; fail: number }>;
    firstLoginAt: number | null;
    tasksCreated: { ui: number; trigger: number };
    runs: { ok: number; fail: number };
    failureHandled: number;
  };
  /** 运行时信息：最近一次请求来自哪个 colo、DO 创建区域提示 */
  runtime?: {
    /** DO 自己的构建信息（用于判断 Worker 与 DO 是否同步更新） */
    build?: { version: string; buildId: string; commit: string };
    /** 存储用量（字节 / 估算上限 / 百分比） */
    storage?: { bytes: number; limitBytes: number; percent: number };
    colo: string | null;
    locationHint: string | null;
    /** 下一次触发器轮询时间（毫秒），没登录/关了就为 null */
    nextPollAt?: number | null;
    /** 上一次轮询时间，null 表示还没轮询过 */
    lastPollAt?: number | null;
    /** 最近一次触发器事件（不管日志有没有被筛掉，这里一定能看到） */
    lastTriggerEvent?: { at: number; ok: boolean; message: string } | null;
    pollSeconds?: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  timezone: 8,
  pollSeconds: 60,
  triggerEnabled: true,
  controlChat: "self",
  adminUserId: "",
  defaultTarget: "",
  stepPollSeconds: 3,
  stepWaitSeconds: 30,
  triggerPrefix: "tg",
  notifyOnFailure: true,
  notifyEvents: ["run_failed", "auto_paused", "session_expired", "connection_error", "daily_digest"],
  digestHour: 22,
  digestWeekday: 0,
  weeklyHour: 22,
  storageWarnPercent: 70,
  successRateThreshold: 80,
  notifyWebhook: "",
  notifyWebhookKind: "generic",
  notifyWebhookSecret: "",
  turnstileSiteKey: "",
  turnstileSecretKey: "",
  templates: [],
};
