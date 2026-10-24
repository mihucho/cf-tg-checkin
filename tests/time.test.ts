/** 调度时间计算：解析 / 下次执行 / 时区边界 */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { local, TZ } from "./fixtures.ts";
import {
  parseTimeOfDay,
  formatTimeOfDay,
  nextDaily,
  nextWindow,
  computeNextRun,
  isSameLocalDay,
} from "../src/schedule/time.ts";

// ---------------------------------------------------------------- 时间解析
test("parseTimeOfDay：各种写法（正例）", () => {
  assert.deepEqual(parseTimeOfDay("9.30"), { hour: 9, minute: 30 });
  assert.deepEqual(parseTimeOfDay("09:30"), { hour: 9, minute: 30 });
  assert.deepEqual(parseTimeOfDay("21：05"), { hour: 21, minute: 5 });
  assert.deepEqual(parseTimeOfDay("0930"), { hour: 9, minute: 30 });
  assert.deepEqual(parseTimeOfDay("2359"), { hour: 23, minute: 59 });
  assert.deepEqual(parseTimeOfDay("9"), { hour: 9, minute: 0 });
  assert.deepEqual(parseTimeOfDay("0"), { hour: 0, minute: 0 });
  assert.deepEqual(parseTimeOfDay("9点"), { hour: 9, minute: 0 });
  assert.deepEqual(parseTimeOfDay("9点半"), { hour: 9, minute: 30 });
  assert.deepEqual(parseTimeOfDay("9点30分"), { hour: 9, minute: 30 });
  assert.deepEqual(parseTimeOfDay("9时15"), { hour: 9, minute: 15 });
});

test("parseTimeOfDay：非法输入一律 null（反例）", () => {
  for (const bad of ["2400", "25", "9:60", "9.60", "签到", "", "每30分", "9点70", "-1", "12:345"]) {
    assert.equal(parseTimeOfDay(bad), null, `应当拒绝：${bad}`);
  }
  assert.equal(formatTimeOfDay(9, 5), "09:05");
});

// ---------------------------------------------------------------- 每天
test("nextDaily：今天未来时刻 / 已过则顺延", () => {
  const midnight = local(2026, 10, 24, 0);
  assert.equal(nextDaily("09:30", midnight, TZ), local(2026, 10, 24, 9, 30));

  const afterNoon = local(2026, 10, 24, 10);
  assert.equal(nextDaily("09:30", afterNoon, TZ), local(2026, 10, 25, 9, 30));

  // 正好是目标时刻（含 5 秒容差）→ 顺延到明天
  const exact = local(2026, 10, 24, 9, 30);
  assert.equal(nextDaily("09:30", exact, TZ), local(2026, 10, 25, 9, 30));
});

test("nextDaily：跨月/跨年边界", () => {
  assert.equal(nextDaily("00:00", local(2026, 12, 31, 23, 59), TZ), local(2027, 1, 1, 0, 0));
  // 时区偏移 0（UTC）
  assert.equal(nextDaily("08:00", local(2026, 10, 24, 9, 0, 0), 0), local(2026, 10, 25, 8, 0, 0));
});

// ---------------------------------------------------------------- 窗口
test("nextWindow：新建任务时落在今天窗口内", () => {
  const now = local(2026, 10, 24, 8, 0);
  const next = nextWindow("09:00", "10:00", now, TZ, () => 0);
  assert.equal(next, local(2026, 10, 24, 9, 0));
});

test("nextWindow：随机点覆盖整个窗口（不是只有前一小时）", () => {
  const now = local(2026, 10, 24, 3);
  const latest = nextWindow("08:30", "12:00", now, TZ, (_min, max) => max);
  assert.equal(latest, local(2026, 10, 24, 12, 0));
});

test("nextWindow：执行完跳过当天窗口（回归：连发 N 次）", () => {
  const inside = local(2026, 10, 24, 9, 15);
  const next = nextWindow("08:30", "10:00", inside, TZ, () => 0, { skipCurrentDay: true });
  assert.equal(next, local(2026, 10, 25, 8, 30));
});

test("nextWindow：跨零点窗口（23:30–00:30）", () => {
  const now = local(2026, 10, 24, 23, 0);
  const next = nextWindow("23:30", "00:30", now, TZ, () => 0);
  assert.equal(next, local(2026, 10, 24, 23, 30));
});

test("nextWindow：窗口已经过去 → 明天", () => {
  const now = local(2026, 10, 24, 11);
  const next = nextWindow("08:30", "10:00", now, TZ, () => 0);
  assert.equal(next, local(2026, 10, 25, 8, 30));
});

// ---------------------------------------------------------------- computeNextRun
test("computeNextRun：interval + jitter", () => {
  const now = local(2026, 10, 24, 0);
  assert.equal(
    computeNextRun({ kind: "interval", intervalMinutes: 30 }, now, TZ, { withoutJitter: true }),
    now + 30 * 60_000,
  );
  assert.equal(
    computeNextRun({ kind: "interval", intervalMinutes: 30, jitterSeconds: 60 }, now, TZ, { random: () => 30 }),
    now + 30 * 60_000 + 30_000,
  );
  // interval 上限/下限
  assert.equal(
    computeNextRun({ kind: "interval", intervalMinutes: 0 }, now, TZ, { withoutJitter: true }),
    now + 60_000,
  );
});

test("computeNextRun：window 执行后跳次日（回归）", () => {
  const inside = local(2026, 10, 24, 8, 45);
  const next = computeNextRun(
    { kind: "window", time: "08:30", windowEnd: "10:00" },
    inside,
    TZ,
    { afterExecution: true, random: () => 0 },
  );
  assert.equal(next, local(2026, 10, 25, 8, 30));
});

test("computeNextRun：daily / once 执行后都是明天", () => {
  const at = local(2026, 10, 24, 9, 30);
  assert.equal(computeNextRun({ kind: "daily", time: "09:30" }, at, TZ), local(2026, 10, 25, 9, 30));
  assert.equal(computeNextRun({ kind: "once", time: "09:30" }, at, TZ), local(2026, 10, 25, 9, 30));
});

// ---------------------------------------------------------------- 同一天
test("isSameLocalDay：按本地时区判断，含跨零点", () => {
  const morning = local(2026, 10, 24, 8, 30);
  const evening = local(2026, 10, 24, 23, 0);
  const nextDay = local(2026, 10, 25, 0, 30);
  assert.equal(isSameLocalDay(morning, evening, TZ), true);
  assert.equal(isSameLocalDay(evening, nextDay, TZ), false);
  // UTC 还是 24 号，但本地已是 25 号 01:00
  assert.equal(isSameLocalDay(local(2026, 10, 25, 1, 0), nextDay, TZ), true);
  // 负时区（-5）
  assert.equal(isSameLocalDay(local(2026, 10, 24, 23, 0, -5), local(2026, 10, 25, 1, 0, -5), -5), false);
});
