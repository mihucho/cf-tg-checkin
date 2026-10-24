/**
 * 成功率告警：比「连续失败 3 次」更早发现问题。
 *
 * 一个任务如果 7 天里 5 次失败、5 次成功（成功率 50%），连续失败计数永远到不了 3，
 * 但它其实已经一半时间在失败了 —— 这类才是最难发现的问题。
 */
import type { LogEntry } from "../types";

export interface TaskRate {
  taskId: number | null;
  name: string;
  ok: number;
  fail: number;
  total: number;
  /** 0-100 的整数 */
  rate: number;
}

export interface LowRateOptions {
  /** 低于这个百分比就告警 */
  threshold: number;
  /** 样本太少不告警（默认 3 次），避免刚建的任务误报 */
  minSamples?: number;
}

/** 按任务汇总窗口内的成功/失败次数 */
export function taskRates(logs: LogEntry[], options: LowRateOptions): TaskRate[] {
  const buckets = new Map<string, TaskRate>();
  for (const log of logs) {
    if (log.source !== "auto" && log.source !== "manual") continue;
    const name = (log.taskName ?? "").trim() || `任务 #${log.taskId ?? "?"}`;
    const key = String(log.taskId ?? name);
    const bucket = buckets.get(key) ?? { taskId: log.taskId ?? null, name, ok: 0, fail: 0, total: 0, rate: 0 };
    if (log.ok) bucket.ok += 1;
    else bucket.fail += 1;
    bucket.total += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map((bucket) => ({
    ...bucket,
    rate: bucket.total ? Math.round((bucket.ok / bucket.total) * 100) : 0,
  }));
}

/** 挑出「样本够多、成功率低于阈值」的任务 */
export function pickLowRateTasks(rates: TaskRate[], options: LowRateOptions): TaskRate[] {
  const minSamples = Math.max(1, options.minSamples ?? 3);
  if (!options.threshold) return [];
  return rates
    .filter((item) => item.total >= minSamples && item.rate < options.threshold)
    .sort((a, b) => a.rate - b.rate || b.total - a.total);
}

/** 告警文案 */
export function describeLowRate(rate: TaskRate, options: { threshold: number; windowDays: number }): string {
  return `最近 ${options.windowDays} 天执行 ${rate.total} 次：成功 ${rate.ok} · 失败 ${rate.fail}（成功率 ${rate.rate}%，低于阈值 ${options.threshold}%）`;
}
