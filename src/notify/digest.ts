/**
 * 日报：什么时候发、发什么（纯函数，便于单测）。
 *
 * 只统计「本地日」的数据，时区跟设置一致。
 */
import type { LogEntry, Task } from "../types";
import { localParts } from "../schedule/time";

export interface DigestStats {
  /** 当天执行次数（成功 / 失败） */
  ok: number;
  fail: number;
  /** 当天失败的任务名（去重、最多 5 个） */
  failedTasks: string[];
  /** 任务总数 / 启用数 */
  totalTasks: number;
  enabledTasks: number;
  /** 下一次执行时间（ms） */
  nextRunAt: number | null;
  /** 最近一次执行结果（给日报补一句上下文） */
  lastMessage?: string | null;
}

export interface DigestContent {
  title: string;
  text: string;
}

/**
 * 距离下一次该发日报还有多久（毫秒）；已经过了今天的时间点就算明天。
 * 返回值用绝对时间戳，便于直接塞进 DO alarm。
 */
export function nextDigestAt(hour: number, minute: number, now: number, timezone: number): number {
  const safeHour = Math.max(0, Math.min(23, Math.floor(hour)));
  const safeMinute = Math.max(0, Math.min(59, Math.floor(minute)));
  const dayMs = 86_400_000;
  const shift = timezone * 3_600_000;
  const dayStart = Math.floor((now + shift) / dayMs) * dayMs - shift;
  let at = dayStart + safeHour * 3_600_000 + safeMinute * 60_000;
  while (at <= now + 60_000) at += dayMs;
  return at;
}

/** 今天这个点是否该发日报了（用 lastAt 保证一天只发一次） */
export function shouldSendDigest(options: {
  now: number;
  hour: number;
  minute: number;
  timezone: number;
  lastSentAt: number | null;
}): boolean {
  const { now, hour, minute, timezone, lastSentAt } = options;
  const today = localParts(now, timezone);
  const scheduled = nextDigestAt(hour, minute, now - 86_400_000, timezone);
  const scheduledParts = localParts(scheduled, timezone);
  // 今天的日报时间点已过？
  if (scheduledParts.day !== today.day) return false;
  if (now < scheduled) return false;
  if (!lastSentAt) return true;
  const last = localParts(lastSentAt, timezone);
  // 同一天发过就不再发
  return !(last.year === today.year && last.month === today.month && last.day === today.day);
}

/** 日报正文（纯函数，给定数据就能算出来） */
export function buildDigest(stats: DigestStats, options: { timezone: number; now: number }): DigestContent {
  const parts = localParts(options.now, options.timezone);
  const date = `${parts.month}/${parts.day}`;
  const total = stats.ok + stats.fail;
  const title = `📊 签到日报 ${date}`;

  const lines: string[] = [];
  if (!total) {
    lines.push("今天没有任务执行记录。");
  } else {
    const rate = Math.round((stats.ok / total) * 100);
    lines.push(`执行 ${total} 次：成功 ${stats.ok} · 失败 ${stats.fail}（成功率 ${rate}%）`);
  }

  if (stats.failedTasks.length) {
    const shown = stats.failedTasks.slice(0, 5);
    lines.push(`失败任务：${shown.join("、")}${stats.failedTasks.length > shown.length ? " 等" : ""}`);
  }

  lines.push(`任务 ${stats.totalTasks} 个（启用 ${stats.enabledTasks}）`);
  if (stats.nextRunAt) {
    const next = localParts(stats.nextRunAt, options.timezone);
    lines.push(
      `下次执行：${next.month}/${next.day} ${String(next.hour).padStart(2, "0")}:${String(next.minute).padStart(2, "0")}`,
    );
  }
  if (stats.lastMessage) lines.push(`最近一次：${stats.lastMessage.slice(0, 80)}`);

  return { title, text: lines.join("\n") };
}

/** 从当天日志里挑出失败的任务名（去重，保留最近的顺序；只算执行日志） */
export function failedTaskNames(logs: LogEntry[], limit = 8): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const log of logs) {
    if (log.ok) continue;
    if (log.source !== "auto" && log.source !== "manual") continue;
    const name = (log.taskName ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

/** 统计任务级别的「启用/总数」，日报里用 */
export function countTasks(tasks: Task[]): { total: number; enabled: number } {
  return { total: tasks.length, enabled: tasks.filter((task) => task.enabled).length };
}
