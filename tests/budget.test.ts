/** 执行时间预算 + 连接错误判定 */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { taskBudgetMs } from "../src/telegram/executor.ts";
import { isConnectionError } from "../src/telegram/client.ts";
import type { Step } from "../src/types.ts";

const task = (steps: Step[], over: Partial<{ timeoutSeconds: number; stepDelaySeconds: number }> = {}) => ({
  steps,
  timeoutSeconds: over.timeoutSeconds ?? 30,
  stepDelaySeconds: over.stepDelaySeconds ?? 3,
});

test("taskBudgetMs：点击步骤按两次等待估算", () => {
  const budget = taskBudgetMs(task([{ type: "click", text: "签到" }]), { stepWaitMs: 30_000, pollIntervalMs: 3000 });
  // 30s*2 + 3s + 关键词等待 30s = 93s
  assert.equal(budget, 93_000);
});

test("taskBudgetMs：等待步骤按秒数累加，且夹在上下限内", () => {
  const small = taskBudgetMs(task([{ type: "wait", seconds: 0 }]), {});
  assert.equal(small, 30_000, "下限 30 秒");
  const big = taskBudgetMs(task([{ type: "wait", seconds: 600 }, { type: "wait", seconds: 600 }]), {});
  assert.equal(big, 240_000, "上限 4 分钟");
});

test("taskBudgetMs：多步骤任务预算随步骤增长", () => {
  const one = taskBudgetMs(task([{ type: "text", text: "a" }]), {});
  const many = taskBudgetMs(task(Array.from({ length: 8 }, () => ({ type: "text" as const, text: "a" }))), {});
  assert.ok(many > one);
});

test("isConnectionError：只认连接层错误", () => {
  for (const message of [
    "Disconnected from dc 5",
    "socket closed",
    "ETIMEDOUT",
    "network error",
    "Timed out",
    "Connection reset by peer",
    "not connected",
  ]) {
    assert.equal(isConnectionError(new Error(message)), true, message);
  }
  for (const message of [
    "目标为空",
    "Could not find the input entity for PeerUser",
    "USERNAME_NOT_OCCUPIED",
    "FLOOD_WAIT_20",
    "请填写 apiId 和 apiHash（my.telegram.org 获取）",
  ]) {
    assert.equal(isConnectionError(new Error(message)), false, message);
  }
  assert.equal(isConnectionError({ errorMessage: "RPC_CALL_FAIL" }), false);
});
