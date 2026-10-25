/**
 * 执行器：抓「最后一步之后的回复」的格式。
 *
 * 用一个极简的假 client 覆盖真实路径：发文本 → 轮询 → 拿到对方的回复。
 * 重点是**日志格式**：多行回复要折成一行，而且不能重复记两次。
 */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { executeTask } from "../src/telegram/executor.ts";
import type { Task } from "../src/types.ts";

const MULTI_LINE = "您已经签到过了！\n当前有 342 点积分";

/** 假 client：第一次 getMessages 只有旧消息，sendMessage 之后能读到机器人回复 */
function fakeClient(reply: { id: number; text: string; out?: boolean }) {
  let sent = false;
  const history: Array<{ id: number; out: boolean; message: string }> = [
    { id: 100, out: false, message: "上一条旧消息" },
  ];
  return {
    calls: { send: 0, fetch: 0 },
    async getMessages() {
      this.calls.fetch += 1;
      return history.slice();
    },
    async sendMessage(_entity: unknown, params: { message: string }) {
      this.calls.send += 1;
      sent = true;
      history.push({ id: 101, out: true, message: params.message });
      if (reply.id > 101) history.push({ id: reply.id, out: reply.out ?? false, message: reply.text });
      return { id: 101 };
    },
    async deleteMessages() {
      return undefined;
    },
    get connected() {
      return true;
    },
    get hasSent() {
      return sent;
    },
  };
}

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

test("执行器：多行回复折成一行，日志里只出现一次", async () => {
  const client = fakeClient({ id: 200, text: MULTI_LINE });
  const outcome = await executeTask(client as never, makeTask(), {
    entity: { id: 1, username: "bot", className: "User", bot: true } as never,
    hooks: { log: () => undefined },
    pollIntervalMs: 500,
    stepWaitMs: 800,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.replyId, 200);
  assert.equal(outcome.replyText, "您已经签到过了！ / 当前有 342 点积分", "回复要折成一行");
  const replyLines = outcome.detail.split("\n").filter((line) => line.includes("收到机器人回复"));
  assert.equal(replyLines.length, 1, "回复只该记一条");
  assert.match(replyLines[0], /收到机器人回复 #200：您已经签到过了！ \/ 当前有 342 点积分/);
  assert.match(outcome.message, /收到回复「您已经签到过了！ \/ 当前有 342 点积分」/);
});

test("执行器：回复来自别人（群组场景）也能拿到", async () => {
  const client = fakeClient({ id: 300, text: "今天签过了" });
  const outcome = await executeTask(client as never, makeTask({ target: { kind: "chat", id: "-100", peerKind: "group" } }), {
    entity: { id: -100, className: "Chat" } as never,
    hooks: { log: () => undefined },
    pollIntervalMs: 500,
    stepWaitMs: 800,
  });
  assert.equal(outcome.peerKind, "group");
  assert.equal(outcome.replyText, "今天签过了");
});

test("执行器：自己的消息不算回复", async () => {
  const client = fakeClient({ id: 400, text: "我自己的回声", out: true });
  const outcome = await executeTask(client as never, makeTask(), {
    entity: { id: 1, username: "bot", className: "User", bot: true } as never,
    hooks: { log: () => undefined },
    pollIntervalMs: 500,
    stepWaitMs: 700,
  });
  assert.equal(outcome.replyText, null);
  assert.equal(outcome.message, "执行完成");
});
