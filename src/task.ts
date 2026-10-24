/**
 * 任务输入规范化 + 去重指纹（纯函数，方便单测）。
 *
 * 这里集中做「边界收敛」：所有来自 HTTP / 触发消息的字段都在这里被裁剪，
 * 避免超长字符串、非法类型、越界数字进数据库或进调度。
 */
import type { Schedule, Step, Target, Task, TaskInput } from "./types";

const MAX_NAME = 80;
const MAX_HANDLE = 80;
const MAX_STEP_TEXT = 500;
const MAX_KEYWORDS = 20;

function clampText(value: unknown, max: number): string {
  return String(value ?? "").slice(0, max);
}

/** 目标去重（按 username / id）并限制数量 */
function dedupeTargets(targets: Target[]): Target[] {
  const seen = new Set<string>();
  const result: Target[] = [];
  for (const target of targets) {
    if (!target || (!target.id && !target.username)) continue;
    const key = `${(target.username || target.id).toLowerCase()}#${target.threadId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);
    if (result.length >= 8) break;
  }
  return result;
}

function normalizeTarget(input: TaskInput | Task): Target {
  const kind = input.target?.kind;
  const safeKind = kind === "channel" || kind === "chat" || kind === "user" ? kind : "user";
  return {
    kind: safeKind,
    id: clampText(input.target?.id, MAX_HANDLE).trim(),
    title: input.target?.title ? clampText(input.target.title, MAX_HANDLE) : undefined,
    username: input.target?.username ? clampText(input.target.username, MAX_HANDLE) : undefined,
    accessHash: input.target?.accessHash ? clampText(input.target.accessHash, 32) : undefined,
    threadId:
      Number.isFinite(Number(input.target?.threadId)) && Number(input.target?.threadId) > 0
        ? Math.floor(Number(input.target?.threadId))
        : undefined,
  };
}

export function normalizeTaskInput(input: TaskInput | Task): TaskInput {
  const schedule = { ...input.schedule };
  if (schedule.kind === "daily" || schedule.kind === "window" || schedule.kind === "once") {
    schedule.time = schedule.time || "09:00";
  }
  if (schedule.kind === "window" && !schedule.windowEnd) schedule.windowEnd = schedule.time ?? "10:00";
  if (schedule.kind === "interval") schedule.intervalMinutes = Math.max(1, Number(schedule.intervalMinutes ?? 60));
  schedule.jitterSeconds = Math.max(0, Math.min(3600, Number(schedule.jitterSeconds ?? 0)));

  const steps = (input.steps ?? [])
    .slice(0, 20)
    .map((step) => {
      if (step.type === "wait") {
        return { type: "wait" as const, seconds: Math.max(0, Math.min(600, Number(step.seconds ?? 3) || 0)) };
      }
      if (step.type === "random") {
        return {
          type: "random" as const,
          options: (step.options ?? []).slice(0, 10).map((item) => clampText(item, MAX_STEP_TEXT)).filter(Boolean),
        };
      }
      if (step.type === "click") {
        return {
          ...step,
          text: clampText(step.text, MAX_STEP_TEXT),
          row: Number.isFinite(Number(step.row)) ? Math.max(0, Math.min(50, Number(step.row))) : undefined,
          column: Number.isFinite(Number(step.column)) ? Math.max(0, Math.min(50, Number(step.column))) : undefined,
        };
      }
      if (step.type === "number") return { type: "number" as const, value: clampText(step.value, 20) };
      return { type: "text" as const, text: clampText(step.text, MAX_STEP_TEXT) };
    })
    .filter((step) => {
      if (step.type === "text") return Boolean(step.text && step.text.trim());
      if (step.type === "random") return (step.options ?? []).length > 0;
      if (step.type === "number") return !!step.value;
      return true;
    });

  const threadId = Number(input.threadId);

  const targets = dedupeTargets([
    normalizeTarget(input),
    ...((input.targets ?? []).map((target) => normalizeTarget({ ...input, target } as TaskInput))),
  ]);

  return {
    name: clampText(input.name, MAX_NAME).trim() || "未命名任务",
    enabled: input.enabled !== false,
    target: targets[0] ?? normalizeTarget(input),
    targets: targets.length > 1 ? targets : undefined,
    threadId: Number.isFinite(threadId) && threadId > 0 ? threadId : null,
    schedule,
    steps,
    successKeywords: (input.successKeywords ?? [])
      .slice(0, MAX_KEYWORDS)
      .map((keyword) => clampText(keyword, 60).trim())
      .filter(Boolean),
    timeoutSeconds: Math.max(5, Math.min(120, Number(input.timeoutSeconds ?? 30))),
    stepDelaySeconds: Math.max(0, Math.min(60, Number(input.stepDelaySeconds ?? 3))),
    deleteAfterSeconds: Math.max(0, Math.min(3600, Number(input.deleteAfterSeconds ?? 0))),
    cleanupPrevious: input.cleanupPrevious !== false,
    source: input.source ?? "ui",
    nextRunAt: input.nextRunAt ?? null,
    lastRunAt: input.lastRunAt ?? null,
    lastResult: input.lastResult ?? null,
    lastMessage: input.lastMessage ?? null,
  };
}

/** 导出的任务：去掉运行态字段，只保留可重建的配置 */
export function taskToExport(task: Task): TaskInput {
  return {
    name: task.name,
    enabled: task.enabled,
    target: task.target,
    targets: task.targets,
    threadId: task.threadId,
    schedule: task.schedule,
    steps: task.steps,
    successKeywords: task.successKeywords,
    timeoutSeconds: task.timeoutSeconds,
    stepDelaySeconds: task.stepDelaySeconds,
    deleteAfterSeconds: task.deleteAfterSeconds,
    cleanupPrevious: task.cleanupPrevious,
    source: task.source,
  };
}

/** 判定"是不是同一个任务"用的指纹（不含 name，name 单独比较） */
export function taskFingerprint(input: {
  target?: Target | null;
  schedule?: Schedule | null;
  steps?: Step[] | null;
  threadId?: number | null;
}): string {
  const targetKey = (input.target?.username || input.target?.id || "").toString().toLowerCase();
  return [
    targetKey,
    JSON.stringify(input.schedule ?? {}),
    JSON.stringify(input.steps ?? []),
    String(input.threadId ?? ""),
  ].join("|");
}
