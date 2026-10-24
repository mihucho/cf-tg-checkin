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
  enabled: boolean;
  target: Target;
  threadId: number | null;
  schedule: Schedule;
  steps: Step[];
  successKeywords: string[];
  timeoutSeconds: number;
  /** 每执行完一个动作后，等多久再做下一个动作（秒，默认 3） */
  stepDelaySeconds: number;
  deleteAfterSeconds: number;
  cleanupPrevious: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastResult: "ok" | "fail" | null;
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

export interface LogEntry {
  id: number;
  taskId: number | null;
  taskName: string | null;
  at: number;
  ok: boolean;
  level: "info" | "warn" | "error";
  message: string;
  detail: string | null;
}

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
  /** 运行时信息：最近一次请求来自哪个 colo、DO 创建区域提示 */
  runtime?: {
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
  turnstileSiteKey: "",
  turnstileSecretKey: "",
};
