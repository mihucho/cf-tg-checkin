/** 任务输入规范化 + 去重指纹 + 设置脱敏（正反例） */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { normalizeTaskInput, taskFingerprint } from "../src/task.ts";
import { redactSettings, shouldAutoFillAdminId } from "../src/settings.ts";
import { DEFAULT_SETTINGS, type TaskInput } from "../src/types.ts";

function input(patch: Partial<TaskInput> = {}): TaskInput {
  return {
    name: "任务",
    enabled: true,
    target: { kind: "user", id: "123", username: "bot" },
    threadId: null,
    schedule: { kind: "daily", time: "09:30" },
    steps: [{ type: "text", text: "签到" }],
    successKeywords: [],
    timeoutSeconds: 30,
    stepDelaySeconds: 3,
    deleteAfterSeconds: 0,
    cleanupPrevious: false,
    source: "ui",
    ...patch,
  } as TaskInput;
}

test("normalizeTaskInput：名称/句柄超长会被截断（防 1MB 落库）", () => {
  const task = normalizeTaskInput(
    input({
      name: "A".repeat(1000),
      target: { kind: "user", id: "x".repeat(500), username: "y".repeat(500), title: "z".repeat(500) },
    }),
  );
  assert.equal(task.name.length, 80);
  assert.equal(task.target.id.length, 80);
  assert.equal(task.target.username!.length, 80);
  assert.equal(task.target.title!.length, 80);
  // 空名字有默认值
  assert.equal(normalizeTaskInput(input({ name: "   " })).name, "未命名任务");
});

test("normalizeTaskInput：cleanupPrevious 未传时默认开启", () => {
  const withoutField = { ...input() } as Partial<TaskInput>;
  delete (withoutField as { cleanupPrevious?: boolean }).cleanupPrevious;
  assert.equal(normalizeTaskInput(withoutField as TaskInput).cleanupPrevious, true);
  assert.equal(normalizeTaskInput(input({ cleanupPrevious: false })).cleanupPrevious, false);
});

test("normalizeTaskInput：非法 target.kind 收敛成 user", () => {
  const task = normalizeTaskInput(input({ target: { kind: "hacker" as never, id: "1" } }));
  assert.equal(task.target.kind, "user");
});

test("normalizeTaskInput：步骤数量/文本/随机选项都被裁剪", () => {
  const manySteps = Array.from({ length: 30 }, (_, i) => ({ type: "text" as const, text: `步骤${i}` }));
  const task = normalizeTaskInput(
    input({
      steps: manySteps,
      stepDelaySeconds: 999,
      timeoutSeconds: 9999,
      deleteAfterSeconds: 999999,
    }),
  );
  assert.equal(task.steps.length, 20);
  assert.equal(task.stepDelaySeconds, 60);
  assert.equal(task.timeoutSeconds, 120);
  assert.equal(task.deleteAfterSeconds, 3600);

  const longText = normalizeTaskInput(input({ steps: [{ type: "text", text: "x".repeat(2000) }] }));
  assert.equal((longText.steps[0] as { text: string }).text.length, 500);

  const random = normalizeTaskInput(
    input({ steps: [{ type: "random", options: Array.from({ length: 20 }, (_, i) => `选项${i}`) }] }),
  );
  assert.equal((random.steps[0] as { options: string[] }).options.length, 10);
});

test("normalizeTaskInput：空步骤被过滤（反例）", () => {
  const task = normalizeTaskInput(
    input({
      steps: [
        { type: "text", text: "   " },
        { type: "random", options: [] },
        { type: "number", value: "" },
        { type: "click", text: "签到" },
      ],
    }),
  );
  assert.deepEqual(task.steps.map((s) => s.type), ["click"]);
});

test("normalizeTaskInput：关键词数量/长度与 threadId / 调度边界", () => {
  const task = normalizeTaskInput(
    input({
      successKeywords: Array.from({ length: 40 }, (_, i) => `kw${i}`.repeat(20)),
      threadId: -5 as never,
      schedule: { kind: "interval", intervalMinutes: 0, jitterSeconds: 99999 },
    }),
  );
  assert.equal(task.successKeywords.length, 20);
  assert.ok(task.successKeywords.every((keyword) => keyword.length <= 60));
  assert.equal(task.threadId, null);
  assert.equal(task.schedule.intervalMinutes, 1);
  assert.equal(task.schedule.jitterSeconds, 3600);
});

test("taskFingerprint：同目标/调度/动作/话题 → 相同；任一项不同 → 不同", () => {
  const base = {
    target: { kind: "user" as const, id: "1", username: "bot" },
    schedule: { kind: "daily" as const, time: "09:30" },
    steps: [{ type: "text" as const, text: "签到" }],
    threadId: null,
  };
  assert.equal(taskFingerprint(base), taskFingerprint({ ...base }));
  assert.notEqual(taskFingerprint(base), taskFingerprint({ ...base, threadId: 12 }));
  assert.notEqual(
    taskFingerprint(base),
    taskFingerprint({ ...base, schedule: { kind: "daily", time: "10:30" } }),
  );
  assert.notEqual(taskFingerprint(base), taskFingerprint({ ...base, steps: [{ type: "text", text: "打卡" }] }));
  // 目标用 username 兜底（大小写不敏感）
  assert.equal(
    taskFingerprint({ ...base, target: { kind: "user", id: "9", username: "BOT" } }),
    taskFingerprint(base),
  );
});

test("redactSettings：Turnstile Secret 不回传，只给已配置标记", () => {
  const redacted = redactSettings({ ...DEFAULT_SETTINGS, turnstileSecretKey: "super-secret" });
  assert.equal(redacted.turnstileSecretKey, "");
  assert.equal(redacted.turnstileSecretConfigured, true);

  const empty = redactSettings({ ...DEFAULT_SETTINGS, turnstileSecretKey: "" });
  assert.equal(empty.turnstileSecretConfigured, false);
});

test("shouldAutoFillAdminId：管理员 ID 默认取当前登录账号（只填一次）", () => {
  // 从没设置过 + 已登录 → 自动填
  assert.equal(shouldAutoFillAdminId({ adminUserId: "", meId: "7066845482" }), true);
  assert.equal(shouldAutoFillAdminId({ adminUserId: null, meId: "7066845482" }), true);
  // 已经设置过 → 不覆盖
  assert.equal(shouldAutoFillAdminId({ adminUserId: "123", meId: "7066845482" }), false);
  // 用户手动清空过（标记已存在）→ 不再自动填
  assert.equal(
    shouldAutoFillAdminId({ adminUserId: "", meId: "7066845482", alreadyAutoFilled: true }),
    false,
  );
  // 还没登录 Telegram → 不填
  assert.equal(shouldAutoFillAdminId({ adminUserId: "", meId: null }), false);
  // 只有空格也算没设置
  assert.equal(shouldAutoFillAdminId({ adminUserId: "   ", meId: "1" }), true);
});

test("DEFAULT_SETTINGS：触发前缀默认 tg，安全默认值", () => {
  assert.equal(DEFAULT_SETTINGS.triggerPrefix, "tg");
  assert.equal(DEFAULT_SETTINGS.stepPollSeconds, 3);
  assert.equal(DEFAULT_SETTINGS.stepWaitSeconds, 30);
  assert.equal(DEFAULT_SETTINGS.triggerEnabled, true);
});
