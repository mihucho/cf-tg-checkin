import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { bucketDaily } from "../src/events.ts";

const DAY = 86400 * 1000;
// 本地时间 2026-10-24 12:00（UTC+8）
const NOW = Date.UTC(2026, 9, 24, 4, 0, 0);

test("bucketDaily：补零到 7 天，按本地日分桶", () => {
  const samples = [
    { ok: true, at: NOW - 1000 },
    { ok: true, at: NOW - 2000 },
    { ok: false, at: NOW - 3000 },
    { ok: true, at: NOW - DAY },
  ];
  const trend = bucketDaily(samples, { now: NOW, tzHours: 8, days: 7 });
  assert.equal(trend.length, 7);
  assert.deepEqual(trend.at(-1), { date: "10-24", ok: 2, fail: 1 });
  assert.deepEqual(trend.at(-2), { date: "10-23", ok: 1, fail: 0 });
  assert.deepEqual(trend[0], { date: "10-18", ok: 0, fail: 0 });
});

test("bucketDaily：时区决定日期归属", () => {
  // 2026-10-24 23:30 (UTC+8) = 15:30 UTC
  const at = Date.UTC(2026, 9, 24, 15, 30);
  const shanghai = bucketDaily([{ ok: true, at }], { now: at, tzHours: 8, days: 3 });
  assert.equal(shanghai.at(-1)?.date, "10-24");

  const utc = bucketDaily([{ ok: true, at }], { now: at, tzHours: 0, days: 3 });
  assert.equal(utc.at(-1)?.date, "10-24");

  // 北京时间 00:30 = 前一天 16:30 UTC
  const early = Date.UTC(2026, 9, 23, 16, 30);
  const shanghaiEarly = bucketDaily([{ ok: true, at: early }], { now: early, tzHours: 8, days: 3 });
  assert.equal(shanghaiEarly.at(-1)?.date, "10-24");
  const utcEarly = bucketDaily([{ ok: true, at: early }], { now: early, tzHours: 0, days: 3 });
  assert.equal(utcEarly.at(-1)?.date, "10-23");
});

test("bucketDaily：窗口外的样本被忽略", () => {
  const trend = bucketDaily([{ ok: true, at: NOW - 10 * DAY }], { now: NOW, tzHours: 8, days: 7 });
  assert.equal(
    trend.reduce((sum, item) => sum + item.ok + item.fail, 0),
    0,
  );
});
