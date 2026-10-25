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

/** 日报/周报的结构化内容：纯文本给 Telegram，卡片给钉钉/飞书 */
export interface DigestCardRow {
  label: string;
  value: string;
}

export interface DigestCard {
  title: string;
  /** 一行汇总（钉钉/企业微信这类只支持有限 markdown 的渠道用它，比两列堆叠好读） */
  summary?: string;
  /** 两列「指标 → 数值」，飞书卡片渲染成字段 */
  rows: DigestCardRow[];
  /** 需要逐条列出的内容（失败任务等） */
  bullets: string[];
  /** 末尾的灰字备注 */
  footnotes: string[];
}

export interface DigestContent {
  title: string;
  text: string;
  card: DigestCard;
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
  const rows: DigestCardRow[] = [];
  const bullets: string[] = [];
  const footnotes: string[] = [];
  const lines: string[] = [];
  let summary = "今天没有任务执行记录。";

  if (!total) {
    lines.push("今天没有任务执行记录。");
  } else {
    const rate = Math.round((stats.ok / total) * 100);
    summary = `执行 ${total} 次：成功 ${stats.ok} · 失败 ${stats.fail}（成功率 ${rate}%）`;
    lines.push(summary);
    rows.push({ label: "执行次数", value: String(total) });
    rows.push({ label: "成功 / 失败", value: `${stats.ok} / ${stats.fail}` });
    rows.push({ label: "成功率", value: `${rate}%` });
  }

  if (stats.failedTasks.length) {
    const shown = stats.failedTasks.slice(0, 5);
    const line = `失败任务：${shown.join("、")}${stats.failedTasks.length > shown.length ? " 等" : ""}`;
    lines.push(line);
    bullets.push(line);
  }

  lines.push(`任务 ${stats.totalTasks} 个（启用 ${stats.enabledTasks}）`);
  footnotes.push(`任务 ${stats.totalTasks} 个（启用 ${stats.enabledTasks}）`);
  if (stats.nextRunAt) {
    const next = localParts(stats.nextRunAt, options.timezone);
    const text = `${next.month}/${next.day} ${String(next.hour).padStart(2, "0")}:${String(next.minute).padStart(2, "0")}`;
    lines.push(`下次执行：${text}`);
    footnotes.push(`下次执行 ${text}`);
  }
  if (stats.lastMessage) {
    lines.push(`最近一次：${stats.lastMessage.slice(0, 80)}`);
    footnotes.push(`最近一次：${stats.lastMessage.slice(0, 80)}`);
  }

  return { title, text: lines.join("\n"), card: { title, summary, rows, bullets, footnotes } };
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

/* ---------------------------------------------------------------- 周报 */

export interface WeeklyStats {
  /** 本周执行次数（成功 / 失败） */
  ok: number;
  fail: number;
  /** 上周同样的数字，用来做对比 */
  prevOk: number;
  prevFail: number;
  /** 失败最多的任务：名字 + 次数（降序，最多 5 个） */
  topFailed: Array<{ name: string; count: number }>;
  totalTasks: number;
  enabledTasks: number;
  nextRunAt: number | null;
}

/** 本周的起点（本地周一 00:00）在真实时间轴上的毫秒值 */
export function weekStart(ms: number, timezone: number): number {
  const shift = timezone * 3_600_000;
  const dayMs = 86_400_000;
  const dayStart = Math.floor((ms + shift) / dayMs) * dayMs - shift;
  // getUTCDay：0=周日，挪成 0=周一
  const weekday = (new Date(dayStart + shift).getUTCDay() + 6) % 7;
  return dayStart - weekday * dayMs;
}

/** 下一次该发周报的时间戳 */
export function nextWeeklyAt(weekday: number, hour: number, minute: number, now: number, timezone: number): number {
  const target = Math.max(0, Math.min(6, Math.floor(weekday))); // 0=周一 … 6=周日
  const start = weekStart(now, timezone);
  let at = start + target * 86_400_000 + Math.max(0, Math.min(23, hour)) * 3_600_000 + Math.max(0, Math.min(59, minute)) * 60_000;
  while (at <= now + 60_000) at += 7 * 86_400_000;
  return at;
}

/** 本周这个点是否该发周报（同一周只发一次） */
export function shouldSendWeeklyDigest(options: {
  now: number;
  weekday: number;
  hour: number;
  minute: number;
  timezone: number;
  lastSentAt: number | null;
}): boolean {
  const { now, weekday, hour, minute, timezone, lastSentAt } = options;
  const thisWeek = weekStart(now, timezone);
  // 本周的周报时间点
  const scheduled = thisWeek + Math.max(0, Math.min(6, Math.floor(weekday))) * 86_400_000
    + Math.max(0, Math.min(23, hour)) * 3_600_000
    + Math.max(0, Math.min(59, minute)) * 60_000;
  if (now < scheduled) return false;
  if (!lastSentAt) return true;
  return weekStart(lastSentAt, timezone) !== thisWeek;
}

/** 周报正文：本周 vs 上周 + 失败最多的任务 */
export function buildWeeklyDigest(stats: WeeklyStats, options: { timezone: number; now: number }): DigestContent {
  const start = weekStart(options.now, options.timezone);
  const from = localParts(start, options.timezone);
  const to = localParts(options.now, options.timezone);
  const title = `📈 签到周报 ${from.month}/${from.day}–${to.month}/${to.day}`;

  const total = stats.ok + stats.fail;
  const prevTotal = stats.prevOk + stats.prevFail;
  const lines: string[] = [];
  const rows: DigestCardRow[] = [];
  const bullets: string[] = [];
  const footnotes: string[] = [];
  let summary = "本周没有任务执行记录。";

  if (!total && !prevTotal) {
    lines.push("本周没有任务执行记录。");
  } else {
    const rate = total ? Math.round((stats.ok / total) * 100) : 0;
    const prevRate = prevTotal ? Math.round((stats.prevOk / prevTotal) * 100) : null;
    summary = `本周执行 ${total} 次：成功 ${stats.ok} · 失败 ${stats.fail}（成功率 ${rate}%）`;
    lines.push(summary);
    rows.push({ label: "本周执行", value: `${total} 次` });
    rows.push({ label: "成功 / 失败", value: `${stats.ok} / ${stats.fail}` });
    rows.push({ label: "本周成功率", value: `${rate}%` });
    if (prevRate === null) {
      lines.push("上周没有执行记录，无法对比。");
    } else {
      const diff = rate - prevRate;
      const arrow = diff > 0 ? "↑" : diff < 0 ? "↓" : "→";
      lines.push(`上周 ${prevTotal} 次 · 成功率 ${prevRate}%（${arrow} ${Math.abs(diff)} 个百分点）`);
      rows.push({ label: "上周成功率", value: `${prevRate}%` });
      rows.push({ label: "变化", value: `${arrow} ${Math.abs(diff)} 个百分点` });
    }
  }

  if (stats.topFailed.length) {
    const list = stats.topFailed.slice(0, 5).map((item) => `${item.name}（${item.count} 次）`).join("、");
    lines.push(`失败最多的任务：${list}`);
    bullets.push(`失败最多：${list}`);
  }

  lines.push(`任务 ${stats.totalTasks} 个（启用 ${stats.enabledTasks}）`);
  footnotes.push(`任务 ${stats.totalTasks} 个（启用 ${stats.enabledTasks}）`);
  if (stats.nextRunAt) {
    const next = localParts(stats.nextRunAt, options.timezone);
    const text = `${next.month}/${next.day} ${String(next.hour).padStart(2, "0")}:${String(next.minute).padStart(2, "0")}`;
    lines.push(`下次执行：${text}`);
    footnotes.push(`下次执行 ${text}`);
  }

  return { title, text: lines.join("\n"), card: { title, summary, rows, bullets, footnotes } };
}

/** 从日志里统计「每个任务失败几次」，降序返回 */
export function topFailingTasks(
  logs: LogEntry[],
  limit = 5,
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const log of logs) {
    if (log.ok) continue;
    if (log.source !== "auto" && log.source !== "manual") continue;
    const name = (log.taskName ?? "").trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}
