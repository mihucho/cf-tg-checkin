/**
 * 执行器：步骤失败与整体结果的判定。
 */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { executeTask } from "../src/telegram/executor.ts";
import type { Task } from "../src/types.ts";

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    name: "测试任务",
    enabled: true,
    target: { kind: "user", id: "1", username: "bot", peerKind: "bot" },
    threadId: null,
    schedule: { kind: "daily", time: "09:30", jitterSeconds: 0 },
    steps: [{ type: "text", text: "/sign" }],
    successKeywords: [],
    timeoutSeconds: 5,
    stepDelaySeconds: 0,
    deleteAfterSeconds: 0,
    cleanupPrevious: false,
    source: "ui",
    nextRunAt: null,
    lastRunAt: null,
    lastResult: null,
    lastMessage: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Task;
}

function failingClient() {
  return {
    async getMessages() {
      return [{ id: 100, out: false, message: "旧消息" }];
    },
    async sendMessage() {
      throw new Error("CHAT_WRITE_FORBIDDEN");
    },
    async deleteMessages() {},
    get connected() {
      return true;
    },
  };
}

test("执行器：所有步骤都失败 → ok=false", async () => {
  const outcome = await executeTask(failingClient() as never, makeTask(), {
    entity: { id: 1, className: "User", bot: true } as never,
    hooks: { log: () => undefined },
    pollIntervalMs: 500,
    stepWaitMs: 500,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /执行失败/);
  assert.match(outcome.detail, /CHAT_WRITE_FORBIDDEN/);
});

test("执行器：命中成功关键词时整体判成功", async () => {
  let sent = false;
  const history: Array<{ id: number; out: boolean; message: string }> = [{ id: 100, out: false, message: "旧消息" }];
  const client = {
    async getMessages() {
      return sent ? [...history, { id: 200, out: false, message: "签到成功" }] : history.slice();
    },
    async sendMessage(_entity: unknown, params: { message: string }) {
      sent = true;
      history.push({ id: 101, out: true, message: params.message });
      return { id: 101 };
    },
    async deleteMessages() {},
    get connected() {
      return true;
    },
  };
  const outcome = await executeTask(
    client as never,
    makeTask({
      steps: [{ type: "text", text: "/sign" }, { type: "click", text: "立即签到" }],
      successKeywords: ["签到成功"],
    }),
    {
      entity: { id: 1, className: "User", bot: true } as never,
      hooks: { log: () => undefined },
      pollIntervalMs: 500,
      stepWaitMs: 400,
    },
  );
  assert.equal(outcome.ok, true);
  assert.match(outcome.message, /命中关键词/);
});

test("执行器：没有步骤 → 明确失败", async () => {
  const outcome = await executeTask(failingClient() as never, makeTask({ steps: [] }), {
    entity: { id: 1, className: "User", bot: true } as never,
    hooks: { log: () => undefined },
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /没有可执行的步骤/);
});
