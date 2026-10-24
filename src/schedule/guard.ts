/**
 * 「这次该不该跑」的判定（纯函数）。
 *
 * 之前这段逻辑内联在 agent.tick 里，没法单测 —— 窗口连发那个 bug 就是这么漏出去的。
 * 现在集中在这里：所有"跳过"的规则都有返回值、有原因，agent 只负责记日志和顺延排期。
 */
import type { Task } from "../types";
import { computeNextRun, isSameLocalDay } from "./time";

export type SkipReason = "not-due" | "already-ran-today" | "too-soon";

/** 连续失败达到阈值就自动暂停任务，避免每天失败还一直试 */
export const FAIL_STREAK_THRESHOLD = 3;

export function shouldAutoPause(failStreak: number, threshold = FAIL_STREAK_THRESHOLD): boolean {
  return Number.isFinite(failStreak) && failStreak >= threshold;
}

export interface RunDecision {
  run: boolean;
  reason?: SkipReason;
  /** 跳过时建议的下一次执行时间（跳过窗口/当天重复时用） */
  nextRunAt?: number;
  detail?: string;
}

export interface RunDecisionOptions {
  /** 手动触发（界面按钮 / Telegram 命令）：无条件执行 */
  manual?: boolean;
  /** 同一任务两次执行的最小间隔（默认 45 秒，保护 interval 类任务） */
  minGapMs?: number;
}

const DEFAULT_MIN_GAP_MS = 45_000;

/**
 * 判定规则（按顺序）：
 *  1. 手动触发 → 直接跑
 *  2. 没到点 → 不跑（不改排期）
 *  3. daily / window / once：**今天已经跑过 → 跳过**（语义就是每天一条，硬约束）
 *  4. 距离上次执行不足 minGap → 跳过（防止任何调度误差造成连发）
 */
export function decideRun(
  task: Task,
  now: number,
  timezone: number,
  options: RunDecisionOptions = {},
): RunDecision {
  if (options.manual) return { run: true };

  if (task.nextRunAt === null || task.nextRunAt === undefined || task.nextRunAt > now) {
    return { run: false, reason: "not-due" };
  }

  const oncePerDay = task.schedule.kind !== "interval";
  if (oncePerDay && task.lastRunAt && isSameLocalDay(task.lastRunAt, now, timezone)) {
    return {
      run: false,
      reason: "already-ran-today",
      nextRunAt: computeNextRun(task.schedule, now, timezone, { afterExecution: true }),
      detail: "daily / window / once 一天只跑一次",
    };
  }

  const minGap = options.minGapMs ?? DEFAULT_MIN_GAP_MS;
  if (task.lastRunAt && now - task.lastRunAt < minGap) {
    return {
      run: false,
      reason: "too-soon",
      nextRunAt: computeNextRun(task.schedule, now, timezone, { afterExecution: true }),
      detail: `${Math.round((now - task.lastRunAt) / 1000)} 秒前刚执行过`,
    };
  }

  return { run: true };
}
