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
  deleteAfterSeconds: number;
  cleanupPrevious: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastResult: "ok" | "fail" | null;
  lastMessage: string | null;
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
}

export interface AccountInfo {
  configured: boolean;
  apiId: number | null;
  phone: string | null;
  signedIn: boolean;
  me: { id: string; username: string | null; firstName: string } | null;
  connected: boolean;
  pendingLogin: { phone: string; stage: "code" | "password" } | null;
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
}

export const DEFAULT_SETTINGS: Settings = {
  timezone: 8,
  pollSeconds: 60,
  triggerEnabled: true,
  controlChat: "self",
  adminUserId: "",
  defaultTarget: "",
};
