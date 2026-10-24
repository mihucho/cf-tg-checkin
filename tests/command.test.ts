/** 任务 ⇄ 指令 往返（正反例） */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { taskToCommand } from "../src/schedule/command.ts";
import { parseTrigger, stripTriggerPrefix } from "../src/schedule/dsl.ts";
import { normalizeTaskInput } from "../src/task.ts";
import { makeTask } from "./fixtures.ts";
import type { Task } from "../src/types.ts";

function roundTrip(task: Task, prefix = "tg") {
  const command = taskToCommand(task, prefix);
  // 真实链路里前缀是 Agent 先剥掉的
  const stripped = stripTriggerPrefix(command, prefix);
  const parsed = parseTrigger(stripped.rest, {
    defaultTarget: task.target.username || task.target.id,
  });
  assert.equal(parsed.ok, true, `指令解析失败：${command} → ${parsed.ok ? "" : parsed.error}`);
  if (!parsed.ok) throw new Error("unreachable");
  return { command, task: parsed.result.task! };
}

test("taskToCommand：daily + 多动作 + 关键词 + 修饰符", () => {
  const source = makeTask({
    name: "签到小助手 /sign",
    target: { kind: "user", id: "1", username: "example_bot" },
    schedule: { kind: "daily", time: "07:40", jitterSeconds: 0 },
    steps: [
      { type: "text", text: "/sign" },
      { type: "click", text: "👤 个人资料" },
      { type: "wait", seconds: 3 },
    ],
    successKeywords: ["签到成功", "已签到"],
    timeoutSeconds: 40,
    stepDelaySeconds: 5,
    deleteAfterSeconds: 0,
    cleanupPrevious: true,
  });

  const { command, task } = roundTrip(source);
  assert.match(command, /^tg 07:40 @example_bot/);
  assert.deepEqual(task.schedule, source.schedule);
  assert.deepEqual(task.steps, source.steps);
  assert.deepEqual(task.successKeywords, source.successKeywords);
  assert.equal(task.timeoutSeconds, 40);
  assert.equal(task.stepDelaySeconds, 5);
  assert.equal(task.name, source.name);
});

test("taskToCommand：窗口 / 间隔 / once", () => {
  const window = roundTrip(
    makeTask({ schedule: { kind: "window", time: "08:30", windowEnd: "10:00", jitterSeconds: 60 } }),
  );
  assert.match(window.command, /08:30-10:00/);
  assert.equal(window.task.schedule.kind, "window");
  assert.equal(window.task.schedule.windowEnd, "10:00");
  assert.equal(window.task.schedule.jitterSeconds, 60);

  const interval = roundTrip(makeTask({ schedule: { kind: "interval", intervalMinutes: 120 } }));
  assert.match(interval.command, /每2小时/);
  assert.equal(interval.task.schedule.intervalMinutes, 120);

  const once = roundTrip(makeTask({ schedule: { kind: "once", time: "23:59" } }));
  assert.match(once.command, /23:59 once/);
  assert.equal(once.task.schedule.kind, "once");
});

test("taskToCommand：带空格的文本/按钮要加引号", () => {
  const source = makeTask({
    steps: [
      { type: "text", text: "📅 每日签到" },
      { type: "click", text: "Check In Now" },
      { type: "random", options: ["早安", "午安"] },
      { type: "number", value: "2" },
    ],
  });
  const { command, task } = roundTrip(source);
  assert.match(command, /"📅 每日签到"/);
  assert.match(command, /btn:"Check In Now"/);
  assert.deepEqual(task.steps, source.steps);
});

test("taskToCommand：任意任务都能被 parseTrigger 重新解析（回归）", () => {
  const sample = makeTask({
    schedule: { kind: "window", time: "08:30", windowEnd: "10:30", jitterSeconds: 300 },
    steps: [
      { type: "click", row: 0, column: 1 },
      { type: "text", text: "签到" },
      { type: "number", value: "1" },
    ],
    cleanupPrevious: false,
    threadId: 12,
    name: "自定义名字",
  });
  const { task } = roundTrip(sample);
  assert.deepEqual(task.steps, sample.steps);
  assert.equal(task.threadId, 12);
  assert.equal(task.name, "自定义名字");
  // #keep → cleanupPrevious false
  assert.equal(task.cleanupPrevious, false);
});

test("taskToCommand：随机选项里含逗号也能原样往返", () => {
  const source = makeTask({
    steps: [{ type: "random", options: ["早上好，今天也要开心", "午安，记得吃饭"] }],
  });
  const { task } = roundTrip(source);
  assert.deepEqual(task.steps, source.steps);
});

test("taskToCommand：多目标输出 到:a|b 并可往返", () => {
  const source = makeTask({
    target: { kind: "user", id: "1", username: "a_bot" },
    targets: [
      { kind: "user", id: "1", username: "a_bot" },
      { kind: "channel", id: "-1001234567890", username: "group_b" },
    ],
  });
  const { command, task } = roundTrip(source);
  assert.match(command, /到:@a_bot\|@group_b/);
  assert.equal(task.targets?.length, 2);
  assert.equal(task.targets?.[1].username, "group_b");
});

test("normalizeTaskInput：多目标去重并限制 8 个", () => {
  const many = normalizeTaskInput({
    name: "x",
    enabled: true,
    target: { kind: "user", id: "1", username: "a" },
    targets: [
      { kind: "user", id: "1", username: "a" },
      { kind: "user", id: "2", username: "b" },
      ...Array.from({ length: 10 }, (_, i) => ({ kind: "user" as const, id: String(100 + i), username: `u${i}` })),
    ],
    schedule: { kind: "daily", time: "09:00" },
    steps: [{ type: "text", text: "hi" }],
    successKeywords: [],
    timeoutSeconds: 30,
    stepDelaySeconds: 3,
    deleteAfterSeconds: 0,
    cleanupPrevious: true,
    source: "ui",
  } as never);
  assert.equal(many.targets?.length, 8);
  assert.equal(new Set(many.targets?.map((t) => t.username)).size, 8);
});

test("taskToCommand：无前缀时不加前缀", () => {
  const command = taskToCommand(makeTask(), "");
  assert.match(command, /^09:30/);
});
