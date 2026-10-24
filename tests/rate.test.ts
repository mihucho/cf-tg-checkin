/** 成功率告警 + 周报 */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { describeLowRate, pickLowRateTasks, taskRates } from "../src/notify/rate.ts";
import {
  buildWeeklyDigest,
  nextWeeklyAt,
  shouldSendWeeklyDigest,
  topFailingTasks,
  weekStart,
} from "../src/notify/digest.ts";
import type { LogEntry } from "../src/types.ts";

const TZ = 8;
const log = (taskId: number, taskName: string, ok: boolean, at = 0, source = "auto") =>
  ({ taskId, taskName, ok, at, source }) as unknown as LogEntry;

test("taskRates：按任务汇总成功/失败", () => {
  const rates = taskRates(
    [log(1, "A", true), log(1, "A", false), log(2, "B", true), log(2, "B", true)],
    { threshold: 80 },
  );
  const byName = Object.fromEntries(rates.map((item) => [item.name, item]));
  assert.deepEqual(
    { ok: byName.A.ok, fail: byName.A.fail, total: byName.A.total, rate: byName.A.rate },
    { ok: 1, fail: 1, total: 2, rate: 50 },
  );
  assert.equal(byName.B.rate, 100);
});

test("taskRates：只统计执行日志，系统日志不算", () => {
  const rates = taskRates(
    [log(1, "A", false), { taskId: 1, taskName: "A", ok: false, source: "system" } as unknown as LogEntry],
    { threshold: 80 },
  );
  assert.equal(rates[0].total, 1);
});

test("pickLowRateTasks：样本太少不报，阈值关闭不报", () => {
  const rates = [
    { taskId: 1, name: "样本少", ok: 0, fail: 2, total: 2, rate: 0 },
    { taskId: 2, name: "真低", ok: 3, fail: 5, total: 8, rate: 38 },
    { taskId: 3, name: "健康", ok: 9, fail: 1, total: 10, rate: 90 },
  ];
  assert.deepEqual(
    pickLowRateTasks(rates, { threshold: 80, minSamples: 3 }).map((item) => item.name),
    ["真低"],
  );
  assert.deepEqual(pickLowRateTasks(rates, { threshold: 0 }), [], "阈值 0 表示关闭");
});

test("describeLowRate：文案带窗口、次数与阈值", () => {
  const text = describeLowRate(
    { taskId: 1, name: "每日签到", ok: 3, fail: 5, total: 8, rate: 38 },
    { threshold: 80, windowDays: 7 },
  );
  assert.match(text, /最近 7 天执行 8 次：成功 3 · 失败 5（成功率 38%，低于阈值 80%）/);
});

test("weekStart：本地周一 00:00", () => {
  // 2026-10-24 是周六
  const sat = Date.UTC(2026, 9, 24, 4, 0);
  const start = weekStart(sat, TZ);
  const local = new Date(start + TZ * 3_600_000);
  assert.equal(local.toISOString().slice(0, 10), "2026-10-19", "本周一是 10/19");
  assert.equal(local.getUTCHours(), 0);
});

test("nextWeeklyAt：过了本周的周报时间就顺延到下周", () => {
  const sat = Date.UTC(2026, 9, 24, 4, 0); // 周六 12:00 本地
  const monday = nextWeeklyAt(0, 22, 0, sat, TZ);
  assert.equal(new Date(monday + TZ * 3_600_000).toISOString().slice(0, 10), "2026-10-26", "下周一");
  // 周日发：还没到
  const sunday = nextWeeklyAt(6, 22, 0, sat, TZ);
  assert.equal(new Date(sunday + TZ * 3_600_000).toISOString().slice(0, 10), "2026-10-25", "本周日");
});

test("shouldSendWeeklyDigest：同一周只发一次", () => {
  const mondayLate = Date.UTC(2026, 9, 26, 14, 30); // 周一 22:30 本地
  assert.equal(
    shouldSendWeeklyDigest({ now: mondayLate, weekday: 0, hour: 22, minute: 0, timezone: TZ, lastSentAt: null }),
    true,
  );
  assert.equal(
    shouldSendWeeklyDigest({ now: mondayLate, weekday: 0, hour: 22, minute: 0, timezone: TZ, lastSentAt: mondayLate }),
    false,
    "同一周已发过",
  );
  assert.equal(
    shouldSendWeeklyDigest({
      now: mondayLate,
      weekday: 0,
      hour: 22,
      minute: 0,
      timezone: TZ,
      lastSentAt: mondayLate - 7 * 86_400_000,
    }),
    true,
    "上周发的不影响本周",
  );
});

test("buildWeeklyDigest：本周 vs 上周 + 失败最多的任务", () => {
  const now = Date.UTC(2026, 9, 24, 4, 0);
  const content = buildWeeklyDigest(
    {
      ok: 20,
      fail: 5,
      prevOk: 10,
      prevFail: 10,
      topFailed: [
        { name: "每日签到", count: 3 },
        { name: "群签到", count: 2 },
      ],
      totalTasks: 4,
      enabledTasks: 3,
      nextRunAt: Date.UTC(2026, 9, 25, 1, 30),
    },
    { timezone: TZ, now },
  );
  assert.match(content.title, /签到周报 10\/19–10\/24/);
  assert.match(content.text, /本周执行 25 次：成功 20 · 失败 5（成功率 80%）/);
  assert.match(content.text, /上周 20 次 · 成功率 50%（↑ 30 个百分点）/);
  assert.match(content.text, /失败最多的任务：每日签到（3 次）、群签到（2 次）/);
  assert.match(content.text, /下次执行：10\/25 09:30/);
});

test("buildWeeklyDigest：上周没有数据时说明无法对比", () => {
  const content = buildWeeklyDigest(
    { ok: 3, fail: 1, prevOk: 0, prevFail: 0, topFailed: [], totalTasks: 1, enabledTasks: 1, nextRunAt: null },
    { timezone: TZ, now: Date.UTC(2026, 9, 24, 4, 0) },
  );
  assert.match(content.text, /上周没有执行记录，无法对比/);
});

test("topFailingTasks：按次数降序，只算执行日志", () => {
  const logs = [
    log(1, "A", false),
    log(1, "A", false),
    log(2, "B", false),
    log(2, "B", true),
    { taskId: 3, taskName: "系统", ok: false, source: "system" } as unknown as LogEntry,
  ];
  assert.deepEqual(topFailingTasks(logs), [
    { name: "A", count: 2 },
    { name: "B", count: 1 },
  ]);
});
