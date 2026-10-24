/** 测试用的任务工厂 */
import type { Task } from "../src/types";

export const TZ = 8;

export function makeTask(patch: Partial<Task> = {}): Task {
  return {
    id: 1,
    name: "测试任务",
    enabled: true,
    target: { kind: "user", id: "1", username: "bot" },
    threadId: null,
    schedule: { kind: "daily", time: "09:30", jitterSeconds: 0 },
    steps: [{ type: "text", text: "签到" }],
    successKeywords: [],
    timeoutSeconds: 30,
    stepDelaySeconds: 3,
    deleteAfterSeconds: 0,
    cleanupPrevious: false,
    nextRunAt: 0,
    lastRunAt: null,
    lastResult: null,
    lastMessage: null,
    source: "ui",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

/** 本地时间（+08）转时间戳，方便写用例 */
export function local(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  timezone = TZ,
): number {
  return Date.UTC(year, month - 1, day, hour, minute) - timezone * 3_600_000;
}
