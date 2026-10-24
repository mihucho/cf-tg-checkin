/** 通知测试：样例内容与配置摘要 */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { buildTestMessage, describeNotifySetup } from "../src/notify/test.ts";
import { DEFAULT_SETTINGS } from "../src/types.ts";

test("describeNotifySetup：把当前配置说清楚", () => {
  const lines = describeNotifySetup({
    ...DEFAULT_SETTINGS,
    notifyWebhook: "https://oapi.dingtalk.com/robot/send?access_token=x",
    notifyWebhookKind: "dingtalk",
    notifyWebhookSecret: "SEC123",
    notifyEvents: ["run_failed", "daily_digest"],
  });
  assert.match(lines[0], /Webhook：钉钉（已配加签）/);
  assert.match(lines[1], /Telegram 私聊：开/);
  assert.match(lines[2], /已勾选通知：执行失败、日报/);
});

test("describeNotifySetup：没配 webhook / 没勾通知时要说明", () => {
  const lines = describeNotifySetup({ ...DEFAULT_SETTINGS, notifyWebhook: "", notifyEvents: [] });
  assert.match(lines[0], /Webhook：未配置/);
  assert.match(lines[2], /一个都没勾/);
});

test("buildTestMessage：标题、摘要行、卡片三件套齐全", () => {
  const sample = buildTestMessage({
    ...DEFAULT_SETTINGS,
    notifyWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/x",
    notifyWebhookKind: "feishu",
    notifyEvents: ["run_failed"],
  });
  assert.equal(sample.title, "🧪 通知测试");
  assert.match(sample.text, /收到说明推送链路是通的/);
  assert.match(sample.card.title, /通知测试/);
  assert.ok(sample.card.rows.length >= 3, "摘要行都进了卡片");
  assert.equal(sample.card.rows[0].label, "Webhook");
  assert.equal(sample.card.rows[0].value, "飞书");
  assert.equal(sample.card.bullets.length, 1);
  assert.ok(sample.card.footnotes[0].includes("通知测试"));
});
