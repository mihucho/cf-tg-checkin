/**
 * 任务输入规范化 + 去重指纹（纯函数，方便单测）。
 *
 * 这里集中做「边界收敛」：所有来自 HTTP / 触发消息的字段都在这里被裁剪，
 * 避免超长字符串、非法类型、越界数字进数据库或进调度。
 */
import type { Schedule, Step, Target, Task, TaskInput } from "./types";
import { defaultName } from "./schedule/dsl";

const MAX_NAME = 80;
const MAX_HANDLE = 80;
const MAX_STEP_TEXT = 500;
const MAX_KEYWORDS = 20;
const MAX_GROUP = 20;

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
    peerKind: ["bot", "user", "group", "channel"].includes(String(input.target?.peerKind))
      ? (input.target?.peerKind as Target["peerKind"])
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

  const steps = (Array.isArray(input.steps) ? input.steps : [])
    .slice(0, 20)
    .map((step) => {
      if (step.type === "wait") {
        return { type: "wait" as const, seconds: Math.max(0, Math.min(600, Number(step.seconds ?? 3) || 0)) };
      }
      if (step.type === "random") {
        return {
          type: "random" as const,
          options: (Array.isArray(step.options) ? step.options : []).slice(0, 10).map((item) => clampText(item, MAX_STEP_TEXT)).filter(Boolean),
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
    ...((Array.isArray(input.targets) ? input.targets : []).map((target) =>
      normalizeTarget({ ...input, target } as TaskInput),
    )),
  ]);

  return {
    name: clampText(input.name, MAX_NAME).trim() || "未命名任务",
    nameAuto: input.nameAuto === true,
    enabled: input.enabled !== false,
    target: targets[0] ?? normalizeTarget(input),
    targets: targets.length > 1 ? targets : undefined,
    threadId: Number.isFinite(threadId) && threadId > 0 ? threadId : null,
    schedule,
    steps,
    successKeywords: (Array.isArray(input.successKeywords) ? input.successKeywords : [])
      .slice(0, MAX_KEYWORDS)
      .map((keyword) => clampText(keyword, 60).trim())
      .filter(Boolean),
    timeoutSeconds: Math.max(5, Math.min(120, Number(input.timeoutSeconds ?? 30))),
    stepDelaySeconds: Math.max(0, Math.min(60, Number(input.stepDelaySeconds ?? 3))),
    deleteAfterSeconds: Math.max(0, Math.min(3600, Number(input.deleteAfterSeconds ?? 0))),
    cleanupPrevious: input.cleanupPrevious !== false,
    group: clampText(input.group, MAX_GROUP).trim() || undefined,
    source: input.source ?? "ui",
    nextRunAt: input.nextRunAt ?? null,
    lastRunAt: input.lastRunAt ?? null,
    lastResult: input.lastResult ?? null,
    lastMessage: input.lastMessage ?? null,
  };
}

/**
 * 把「补全后的目标」写回任务的正确位置（纯函数）。
 *
 * 多目标任务里每个目标都会在运行时补 username / title / accessHash，
 * 但**只有主目标能写 target 字段**，其余必须写回 targets[i]，
 * 否则第 2 个目标会被当成主目标覆盖掉（还会按它改任务名）。
 */
export function applyTargetPatch(
  task: Task,
  index: number,
  patch: Target,
  options: { renameTo?: string | null } = {},
): Partial<TaskInput> {
  const targets = task.targets && task.targets.length > 1 ? task.targets : null;
  const isPrimary = !targets || index <= 0;

  if (isPrimary) {
    return {
      target: patch,
      ...(targets ? { targets: [patch, ...targets.slice(1)] } : {}),
      ...(options.renameTo ? { name: options.renameTo } : {}),
    };
  }

  const nextTargets = targets.slice();
  nextTargets[index] = patch;
  return { targets: nextTargets };
}

/**
 * 目标补全出显示名后，要不要把任务名一起改？
 *
 * - `nameAuto === true`：名字本来就是系统按目标生成的 → 可以改
 * - `nameAuto === false`：用户自己起的 → **永远不动**（哪怕名字恰好以旧目标开头）
 * - 老数据没有标记：只有名字仍等于「当前目标 + 动作」算出来的默认名时才改，
 *   这样手动改过名字的老任务也不会被覆盖
 */
export function shouldAutoRename(task: Pick<Task, "name" | "nameAuto" | "target" | "steps">): boolean {
  if (typeof task.nameAuto === "boolean") return task.nameAuto;
  return task.name === defaultName(task.target, "", task.steps ?? []);
}

/** 导出的任务：去掉运行态字段，只保留可重建的配置 */
export function taskToExport(task: Task): TaskInput {
  return {
    name: task.name,
    nameAuto: task.nameAuto,
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
    group: task.group,
    source: task.source,
  };
}

/** 判定"是不是同一个任务"用的指纹（不含 name，name 单独比较） */
export function taskFingerprint(input: {
  target?: Target | null;
  targets?: Target[] | null;
  schedule?: Schedule | null;
  steps?: Step[] | null;
  threadId?: number | null;
}): string {
  const keyOf = (target: Target | null | undefined) =>
    `${(target?.username || target?.id || "").toString().toLowerCase()}#${target?.threadId ?? ""}`;
  // 多目标任务要连附加目标一起算，否则「主目标相同、附加目标不同」会被误判成重复
  const targetsKey = (input.targets ?? []).map(keyOf).join(",");
  return [
    keyOf(input.target),
    targetsKey,
    JSON.stringify(input.schedule ?? {}),
    JSON.stringify(input.steps ?? []),
    String(input.threadId ?? ""),
  ].join("|");
}
