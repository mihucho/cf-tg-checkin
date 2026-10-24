/** 「这次该不该跑」的判定（回归：窗口连发 / 一天多次） */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { local, makeTask, TZ } from "./fixtures.ts";
import { decideRun, shouldAutoPause, FAIL_STREAK_THRESHOLD } from "../src/schedule/guard.ts";

const now = local(2026, 10, 24, 9, 15);

test("decideRun：没到点不跑", () => {
  const task = makeTask({ nextRunAt: now + 60_000 });
  assert.deepEqual(decideRun(task, now, TZ), { run: false, reason: "not-due" });
});

test("decideRun：到点就跑", () => {
  const task = makeTask({ nextRunAt: now - 1_000, lastRunAt: null });
  assert.equal(decideRun(task, now, TZ).run, true);
});

test("decideRun：手动触发无条件跑（即使今天已经跑过）", () => {
  const task = makeTask({
    schedule: { kind: "daily", time: "09:00", jitterSeconds: 0 },
    nextRunAt: now + 60 * 60_000,
    lastRunAt: now - 60_000,
  });
  assert.equal(decideRun(task, now, TZ, { manual: true }).run, true);
});

test("decideRun：daily 今天已跑过 → 跳过并顺延到明天（回归）", () => {
  const task = makeTask({
    schedule: { kind: "daily", time: "09:00", jitterSeconds: 0 },
    nextRunAt: now - 1_000,
    lastRunAt: local(2026, 10, 24, 9, 0),
  });
  const decision = decideRun(task, now, TZ);
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "already-ran-today");
  assert.equal(decision.nextRunAt, local(2026, 10, 25, 9, 0));
});

test("decideRun：window 今天已跑过 → 跳过并跳到明天窗口（回归：连发 N 次）", () => {
  const task = makeTask({
    schedule: { kind: "window", time: "08:30", windowEnd: "10:00", jitterSeconds: 0 },
    nextRunAt: now - 1_000,
    lastRunAt: local(2026, 10, 24, 9, 10),
  });
  const decision = decideRun(task, now, TZ);
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "already-ran-today");
  assert.ok(decision.nextRunAt! >= local(2026, 10, 25, 8, 30), "应当排到明天的窗口");
});

test("decideRun：once 今天已跑过 → 跳过", () => {
  const task = makeTask({
    schedule: { kind: "once", time: "09:00", jitterSeconds: 0 },
    nextRunAt: now - 1_000,
    lastRunAt: local(2026, 10, 24, 9, 0),
  });
  assert.equal(decideRun(task, now, TZ).reason, "already-ran-today");
});

test("decideRun：昨天跑过的 daily 今天正常跑", () => {
  const task = makeTask({
    schedule: { kind: "daily", time: "09:00", jitterSeconds: 0 },
    nextRunAt: now - 1_000,
    lastRunAt: local(2026, 10, 23, 9, 0),
  });
  assert.equal(decideRun(task, now, TZ).run, true);
});

test("decideRun：interval 45 秒内不重复（护栏）", () => {
  const task = makeTask({
    schedule: { kind: "interval", intervalMinutes: 1, jitterSeconds: 0 },
    nextRunAt: now - 1_000,
    lastRunAt: now - 20_000,
  });
  const decision = decideRun(task, now, TZ);
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "too-soon");
  assert.ok(decision.nextRunAt! > now);
});

test("shouldAutoPause：连续失败到阈值才暂停", () => {
  assert.equal(shouldAutoPause(0), false);
  assert.equal(shouldAutoPause(FAIL_STREAK_THRESHOLD - 1), false);
  assert.equal(shouldAutoPause(FAIL_STREAK_THRESHOLD), true);
  assert.equal(shouldAutoPause(FAIL_STREAK_THRESHOLD + 5), true);
  assert.equal(shouldAutoPause(Number.NaN), false);
  // 阈值可调
  assert.equal(shouldAutoPause(2, 2), true);
});

test("decideRun：interval 超过最小间隔后允许跑", () => {
  const task = makeTask({
    schedule: { kind: "interval", intervalMinutes: 1, jitterSeconds: 0 },
    nextRunAt: now - 1_000,
    lastRunAt: now - 60_000,
  });
  assert.equal(decideRun(task, now, TZ).run, true);
});
