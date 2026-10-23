/**
 * 调度时间计算。时区用固定偏移（小时，可带小数）表示，不依赖 Intl 时区数据库，
 * 这样 Workers 里零依赖、可单元测试。
 */
import type { Schedule, Task } from "../types";

const MINUTE = 60_000;
const DAY = 86_400_000;

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0=周日 */
  weekday: number;
}

/**
 * 时间写法：
 *   9 / 21            → 09:00 / 21:00（裸小时）
 *   9.30 / 09:30 / 21：05
 *   0930 / 2359
 *   9点 / 9点30 / 9点30分 / 9点半 / 9时15分
 */
export function parseTimeOfDay(input: string): { hour: number; minute: number } | null {
  const value = input.trim();
  if (!value) return null;

  // 9.30 / 09:30 / 21：05
  let match = /^(\d{1,2})[:.：](\d{1,2})$/.exec(value);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour > 23 || minute > 59 ? null : { hour, minute };
  }

  // 0930 / 2359
  match = /^(\d{3,4})$/.exec(value);
  if (match) {
    const digits = match[1];
    const hour = Number(digits.slice(0, digits.length - 2));
    const minute = Number(digits.slice(-2));
    return hour > 23 || minute > 59 ? null : { hour, minute };
  }

  // 9点 / 9点半 / 9点30分 / 9时15
  match = /^(\d{1,2})\s*[点时](半|\d{1,2}分?)?$/.exec(value);
  if (match) {
    const hour = Number(match[1]);
    const rest = match[2];
    const minute = !rest ? 0 : rest === "半" ? 30 : Number(rest.replace("分", ""));
    return hour > 23 || minute > 59 ? null : { hour, minute };
  }

  // 裸小时：9 / 09 / 21 → 整点
  match = /^(\d{1,2})$/.exec(value);
  if (match) {
    const hour = Number(match[1]);
    return hour > 23 ? null : { hour, minute: 0 };
  }

  return null;
}

export function formatTimeOfDay(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function localParts(ms: number, timezone: number): LocalParts {
  const shifted = new Date(ms + timezone * 3_600_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

/** 本地「今天 00:00」在真实时间轴上的毫秒值 */
function localDayStart(ms: number, timezone: number): number {
  const shifted = ms + timezone * 3_600_000;
  return Math.floor(shifted / DAY) * DAY - timezone * 3_600_000;
}

function atTimeOfDay(dayStart: number, hour: number, minute: number): number {
  return dayStart + hour * 3_600_000 + minute * MINUTE;
}

/** 下一次「每天 HH:MM」，now 之后至少 5 秒 */
export function nextDaily(time: string, now: number, timezone: number): number {
  const parsed = parseTimeOfDay(time) ?? { hour: 9, minute: 0 };
  let dayStart = localDayStart(now, timezone);
  let target = atTimeOfDay(dayStart, parsed.hour, parsed.minute);
  while (target <= now + 5_000) {
    dayStart += DAY;
    target = atTimeOfDay(dayStart, parsed.hour, parsed.minute);
  }
  return target;
}

/** 在 [start, end] 窗口内随机挑一个时刻（跨零点时 end 视为次日） */
export function nextWindow(
  start: string,
  end: string,
  now: number,
  timezone: number,
  random: (min: number, max: number) => number = randomInt,
): number {
  const from = parseTimeOfDay(start) ?? { hour: 9, minute: 0 };
  const to = parseTimeOfDay(end) ?? { hour: 10, minute: 0 };
  const dayStart = localDayStart(now, timezone);
  for (let offset = 0; offset <= 2; offset++) {
    const day = dayStart + offset * DAY;
    let windowStart = atTimeOfDay(day, from.hour, from.minute);
    let windowEnd = atTimeOfDay(day, to.hour, to.minute);
    if (windowEnd <= windowStart) windowEnd += DAY;
    if (windowStart <= now + 5_000) {
      if (windowEnd <= now + 5_000) continue;
      windowStart = now + 5_000;
    }
    const span = Math.max(0, windowEnd - windowStart);
    return windowStart + random(0, Math.min(span, 3_600_000));
  }
  return now + DAY;
}

export function randomInt(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

export interface NextRunOptions {
  /** 忽略 jitter（用于展示） */
  withoutJitter?: boolean;
  random?: (min: number, max: number) => number;
}

/**
 * 计算任务的下一次执行时间（毫秒时间戳）。
 * 结果会被持久化到 nextRunAt，调度器只比较 nextRunAt <= now。
 */
export function computeNextRun(
  schedule: Schedule,
  now: number,
  timezone: number,
  options: NextRunOptions = {},
): number {
  const random = options.random ?? randomInt;
  const jitterSeconds = Math.max(0, Math.min(3600, schedule.jitterSeconds ?? 0));
  const jitter = options.withoutJitter || !jitterSeconds ? 0 : random(0, jitterSeconds) * 1000;

  switch (schedule.kind) {
    case "interval": {
      const minutes = Math.max(1, Math.min(24 * 60, schedule.intervalMinutes ?? 60));
      return now + minutes * MINUTE + jitter;
    }
    case "window": {
      return nextWindow(schedule.time ?? "09:00", schedule.windowEnd ?? "10:00", now, timezone, random) + jitter;
    }
    case "once":
    case "daily":
    default: {
      return nextDaily(schedule.time ?? "09:00", now, timezone) + jitter;
    }
  }
}

export function computeTaskNextRun(task: Task, now: number, timezone: number, options?: NextRunOptions): number {
  return computeNextRun(task.schedule, now, timezone, options);
}

/** 人类可读的调度描述 */
export function describeSchedule(schedule: Schedule, timezone: number): string {
  const jitter = schedule.jitterSeconds
    ? `（随机延迟 0-${schedule.jitterSeconds}s）`
    : "";
  switch (schedule.kind) {
    case "interval":
      return `每 ${schedule.intervalMinutes ?? 60} 分钟${jitter}`;
    case "window":
      return `每天 ${schedule.time ?? "09:00"}–${schedule.windowEnd ?? "10:00"} 随机${jitter}`;
    case "once":
      return `仅一次 ${schedule.time ?? "09:00"}${jitter}`;
    case "daily":
    default:
      return `每天 ${schedule.time ?? "09:00"}${jitter}`;
  }
}

export function formatInTimezone(ms: number | null, timezone: number): string {
  if (!ms) return "—";
  const parts = localParts(ms, timezone);
  return `${parts.month}/${parts.day} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}
