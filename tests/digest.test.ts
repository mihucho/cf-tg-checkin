/** 日报时间 + 内容 + 通知类型目录 */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { buildDigest, countTasks, failedTaskNames, nextDigestAt, shouldSendDigest } from "../src/notify/digest.ts";
import {
  NOTIFY_EVENTS,
  defaultNotifyEvents,
  isNotifyEventId,
  isThrottledEvent,
  normalizeNotifyEvents,
} from "../src/notify/events.ts";
import type { LogEntry, Task } from "../src/types.ts";

const TZ = 8;
/** 2026-10-24 20:00（UTC+8） */
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

test("通知类型目录：默认开启的是关键项，且都认识", () => {
  const defaults = defaultNotifyEvents();
  assert.ok(defaults.includes("run_failed"));
  assert.ok(defaults.includes("auto_paused"));
  assert.ok(defaults.includes("daily_digest"));
  assert.equal(defaults.includes("run_success"), false, "执行成功默认关（太吵）");
  for (const id of defaults) assert.equal(isNotifyEventId(id), true);
  assert.equal(isNotifyEventId("hack"), false);
});

test("normalizeNotifyEvents：过滤未知、去重、按目录顺序", () => {
  const normalized = normalizeNotifyEvents(["daily_digest", "hack", "run_failed", "daily_digest"]);
  assert.deepEqual(normalized, ["run_failed", "daily_digest"]);
  assert.deepEqual(normalizeNotifyEvents("not-an-array"), []);
});

test("节流标记：周期性/噪音类事件才节流", () => {
  assert.equal(isThrottledEvent("run_failed"), true);
  assert.equal(isThrottledEvent("daily_digest"), false, "日报一天一次，不需要额外节流");
  assert.equal(isThrottledEvent("weekly_digest"), false, "周报一周一次，不需要额外节流");
  assert.equal(isThrottledEvent("run_success"), false);
  assert.deepEqual(
    NOTIFY_EVENTS.filter((item) => item.throttled).map((item) => item.id),
    ["run_failed", "session_expired", "connection_error", "login_failed", "storage_warning", "success_rate_low"],
  );
});

test("nextDigestAt：今天没过就是今天，过了就是明天", () => {
  // 20:00 时，22:00 的日报应该在今天
  const today = nextDigestAt(22, 0, NOW, TZ);
  assert.equal(new Date(today + TZ * 3600_000).toISOString().slice(0, 10), "2026-10-24");
  // 23:00 时，22:00 的日报应该在明天
  const late = nextDigestAt(22, 0, Date.UTC(2026, 9, 24, 15, 0), TZ);
  assert.equal(new Date(late + TZ * 3600_000).toISOString().slice(0, 10), "2026-10-25");
});

test("shouldSendDigest：到点且当天没发过才发", () => {
  const at22 = Date.UTC(2026, 9, 24, 14, 0); // 22:00 本地
  assert.equal(shouldSendDigest({ now: at22, hour: 22, minute: 0, timezone: TZ, lastSentAt: null }), true);
  // 还没到点
  assert.equal(shouldSendDigest({ now: NOW, hour: 22, minute: 0, timezone: TZ, lastSentAt: null }), false);
  // 今天已经发过
  assert.equal(
    shouldSendDigest({ now: at22 + 60_000, hour: 22, minute: 0, timezone: TZ, lastSentAt: at22 }),
    false,
  );
  // 昨天发过，今天还能发
  assert.equal(
    shouldSendDigest({ now: at22, hour: 22, minute: 0, timezone: TZ, lastSentAt: at22 - 86_400_000 }),
    true,
  );
});

test("buildDigest：有数据的日报包含统计与失败任务", () => {
  const content = buildDigest(
    {
      ok: 9,
      fail: 3,
      failedTasks: ["每日签到", "群签到"],
      totalTasks: 5,
      enabledTasks: 4,
      nextRunAt: Date.UTC(2026, 9, 25, 1, 30),
      lastMessage: "命中关键词「签到成功」",
    },
    { timezone: TZ, now: NOW },
  );
  assert.equal(content.title, "📊 签到日报 10/24");
  assert.match(content.text, /执行 12 次：成功 9 · 失败 3（成功率 75%）/);
  assert.match(content.text, /失败任务：每日签到、群签到/);
  assert.match(content.text, /任务 5 个（启用 4）/);
  assert.match(content.text, /下次执行：10\/25 09:30/);
  assert.match(content.text, /最近一次：命中关键词/);
});

test("buildDigest：没执行记录时给一句人话", () => {
  const content = buildDigest(
    { ok: 0, fail: 0, failedTasks: [], totalTasks: 0, enabledTasks: 0, nextRunAt: null },
    { timezone: TZ, now: NOW },
  );
  assert.match(content.text, /今天没有任务执行记录/);
});

test("failedTaskNames：去重且只算失败的", () => {
  const logs = [
    { taskName: "A", ok: false, source: "auto" },
    { taskName: "A", ok: false, source: "auto" },
    { taskName: "B", ok: true, source: "auto" },
    { taskName: "C", ok: false, source: "manual" },
    { taskName: null, ok: false, source: "auto" },
    // 系统日志（例如「目标已自动补全」）不该出现在失败任务里
    { taskName: "系统消息", ok: false, source: "system" },
  ] as unknown as LogEntry[];
  assert.deepEqual(failedTaskNames(logs), ["A", "C"]);
});

test("countTasks：统计启用数", () => {
  const tasks = [{ enabled: true }, { enabled: false }, { enabled: true }] as unknown as Task[];
  assert.deepEqual(countTasks(tasks), { total: 3, enabled: 2 });
});
