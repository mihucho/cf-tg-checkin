/** 失败提醒 Webhook：渠道包体 / 钉钉加签 / 响应判定 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "./harness.ts";
import {
  buildWebhookBody,
  buildWebhookPayload,
  detectWebhookKind,
  dingtalkSign,
  parseWebhookResult,
} from "../src/notify/webhook.ts";

const message = { title: "⚠️ 任务「每日签到」执行失败", text: "未匹配到关键词", at: 1761000000000 };

test("detectWebhookKind：只用于老配置兜底", () => {
  assert.equal(detectWebhookKind("https://oapi.dingtalk.com/robot/send?access_token=x"), "dingtalk");
  assert.equal(detectWebhookKind("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x"), "wecom");
  assert.equal(detectWebhookKind("https://open.feishu.cn/open-apis/bot/v2/hook/x"), "feishu");
  assert.equal(detectWebhookKind("https://open.larksuite.com/open-apis/bot/v2/hook/x"), "feishu");
  assert.equal(detectWebhookKind("https://example.com/hook"), "generic");
  assert.equal(detectWebhookKind("不是 URL"), "generic");
});

test("buildWebhookBody：各渠道包体结构", () => {
  const dingtalk = JSON.parse(buildWebhookBody("dingtalk", message));
  assert.equal(dingtalk.msgtype, "text");
  assert.equal(dingtalk.text.content, `${message.title}\n${message.text}`);
  assert.equal(dingtalk.at.isAtAll, false);

  const wecom = JSON.parse(buildWebhookBody("wecom", message));
  assert.equal(wecom.msgtype, "text");
  assert.equal(wecom.text.content, `${message.title}\n${message.text}`);

  const feishu = JSON.parse(buildWebhookBody("feishu", message));
  assert.equal(feishu.msg_type, "text");
  assert.equal(feishu.content.text, `${message.title}\n${message.text}`);

  const generic = JSON.parse(buildWebhookBody("generic", { ...message, taskId: 7, taskName: "每日签到" }));
  assert.equal(generic.taskId, 7);
  assert.equal(generic.ok, false);
  assert.equal(generic.message, message.text);
  assert.equal(generic.text, `${message.title}\n${message.text}`);
});

test("钉钉加签：签名随 timestamp 变化，且写进 URL 的 query", async () => {
  const secret = "SEC012345";
  const a = await dingtalkSign(secret, 1761000000000);
  const b = await dingtalkSign(secret, 1761000000001);
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9+/=]+$/);

  const payload = await buildWebhookPayload(
    "https://oapi.dingtalk.com/robot/send?access_token=abc",
    secret,
    message,
    { kind: "dingtalk", now: 1761000000000 },
  );
  const url = new URL(payload.url);
  assert.equal(url.searchParams.get("access_token"), "abc");
  assert.equal(url.searchParams.get("timestamp"), "1761000000000");
  assert.equal(url.searchParams.get("sign"), a);
});

test("钉钉加签：与官方算法（node:crypto 独立实现）逐字节一致", async () => {
  const secret = "SECa1b2c3d4e5";
  const timestamp = 1761000000000;
  // 官方：sign = base64(HMAC-SHA256(key=secret, message=`${timestamp}\n${secret}`))
  const expected = createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
  assert.equal(await dingtalkSign(secret, timestamp), expected);
});

test("未配置加签密钥时不改 URL", async () => {
  const payload = await buildWebhookPayload(
    "https://oapi.dingtalk.com/robot/send?access_token=abc",
    "",
    message,
    { kind: "dingtalk", now: 1761000000000 },
  );
  assert.equal(payload.url, "https://oapi.dingtalk.com/robot/send?access_token=abc");
});

test("渠道优先用设置里的手动选择，而不是按域名猜", async () => {
  const payload = await buildWebhookPayload("https://example.com/hook", "", message, { kind: "feishu" });
  assert.equal(payload.kind, "feishu");
  assert.equal(JSON.parse(payload.body).msg_type, "text");
});

test("parseWebhookResult：HTTP 200 也可能是业务失败", () => {
  // 钉钉：errcode 非 0（例如关键词不匹配 / 加签错误）
  assert.equal(parseWebhookResult("dingtalk", 200, '{"errcode":0,"errmsg":"ok"}').ok, true);
  const dingFail = parseWebhookResult("dingtalk", 200, '{"errcode":310000,"errmsg":"sign not match"}');
  assert.equal(dingFail.ok, false);
  assert.match(dingFail.error ?? "", /310000/);

  assert.equal(parseWebhookResult("wecom", 200, '{"errcode":0}').ok, true);
  assert.equal(parseWebhookResult("wecom", 200, '{"errcode":93000,"errmsg":"invalid webhook url"}').ok, false);

  assert.equal(parseWebhookResult("feishu", 200, '{"code":0,"msg":"success"}').ok, true);
  assert.equal(parseWebhookResult("feishu", 200, '{"code":19021,"msg":"sign match fail"}').ok, false);
  // 老版本飞书字段
  assert.equal(parseWebhookResult("feishu", 200, '{"StatusCode":0}').ok, true);
  assert.equal(parseWebhookResult("feishu", 200, '{"StatusCode":9499,"StatusMessage":"Bad Request"}').ok, false);

  // 通用：非 JSON / 空 body 视为成功，ok:false 视为失败
  assert.equal(parseWebhookResult("generic", 200, "OK").ok, true);
  assert.equal(parseWebhookResult("generic", 204, "").ok, true);
  assert.equal(parseWebhookResult("generic", 200, '{"ok":false,"error":"denied"}').ok, false);
  assert.equal(parseWebhookResult("generic", 500, "boom").ok, false);
});

/* ------------------------------------------------ 日报/周报的卡片渲染 */

import { buildDigest, buildWeeklyDigest } from "../src/notify/digest.ts";

const digestCard = buildDigest(
  {
    ok: 9,
    fail: 3,
    failedTasks: ["每日签到", "群签到"],
    totalTasks: 5,
    enabledTasks: 4,
    nextRunAt: Date.UTC(2026, 9, 25, 1, 30),
    lastMessage: "命中关键词「签到成功」",
  },
  { timezone: 8, now: Date.UTC(2026, 9, 24, 12, 0) },
).card;

test("卡片：钉钉用 markdown 包体", () => {
  const body = JSON.parse(buildWebhookBody("dingtalk", { ...message, card: digestCard }));
  assert.equal(body.msgtype, "markdown");
  assert.equal(body.markdown.title, "📊 签到日报 10/24");
  assert.match(body.markdown.text, /### 📊 签到日报 10\/24/);
  assert.match(body.markdown.text, /\*\*成功率\*\*：75% {2}/);
  assert.match(body.markdown.text, /- 每日签到/);
  assert.match(body.markdown.text, /> 任务 5 个（启用 4）/);
  assert.equal(body.at.isAtAll, false);
});

test("卡片：飞书用交互卡片 + 两列 fields", () => {
  const body = JSON.parse(buildWebhookBody("feishu", { ...message, card: digestCard }));
  assert.equal(body.msg_type, "interactive");
  assert.equal(body.card.header.title.content, "📊 签到日报 10/24");
  const fields = body.card.elements[0].fields;
  assert.ok(fields.length >= 3);
  assert.equal(fields[0].is_short, true);
  assert.match(fields[0].text.content, /执行次数/);
  // 明细 + 备注都在
  const text = JSON.stringify(body.card.elements);
  assert.match(text, /每日签到/);
  assert.match(text, /任务 5 个（启用 4）/);
});

test("卡片：企业微信用 markdown，周报标题换颜色", () => {
  const weekly = buildWeeklyDigest(
    {
      ok: 20,
      fail: 5,
      prevOk: 10,
      prevFail: 10,
      topFailed: [{ name: "每日签到", count: 3 }],
      totalTasks: 4,
      enabledTasks: 3,
      nextRunAt: null,
    },
    { timezone: 8, now: Date.UTC(2026, 9, 24, 4, 0) },
  ).card;
  const wecom = JSON.parse(buildWebhookBody("wecom", { ...message, card: weekly }));
  assert.equal(wecom.msgtype, "markdown");
  assert.match(wecom.markdown.content, /本周执行\*\*：25 次/);
  assert.match(wecom.markdown.content, /↑ 30 个百分点/);

  const feishu = JSON.parse(buildWebhookBody("feishu", { ...message, card: weekly }));
  assert.equal(feishu.card.header.template, "indigo", "周报用另一种主题色");
});

test("卡片：没有执行记录时也给一句人话（不留空白）", () => {
  const empty = buildDigest(
    { ok: 0, fail: 0, failedTasks: [], totalTasks: 2, enabledTasks: 1, nextRunAt: null },
    { timezone: 8, now: Date.UTC(2026, 9, 24, 12, 0) },
  ).card;
  const body = JSON.parse(buildWebhookBody("dingtalk", { ...message, card: empty }));
  assert.match(body.markdown.text, /今天没有任务执行记录/);
  assert.doesNotMatch(body.markdown.text, /\n\n\n/, "不该出现连续空行");
});

test("卡片：通用 JSON 不用卡片，仍发扁平字段", () => {
  const body = JSON.parse(buildWebhookBody("generic", { ...message, card: digestCard }));
  assert.equal(body.ok, false);
  assert.equal(body.text, `${message.title}\n${message.text}`);
  assert.equal(body.msgtype, undefined);
});

/* ------------------------------------------------ 地址补全 */

import { normalizeWebhookUrl } from "../src/notify/webhook.ts";

test("normalizeWebhookUrl：裸 token 按渠道补成完整地址", () => {
  const token = "76296f3669f0c48fab916ed96cc183cc9f17e8a5a063447e065555538e114acd";
  assert.equal(
    normalizeWebhookUrl(token, "dingtalk"),
    `https://oapi.dingtalk.com/robot/send?access_token=${token}`,
  );
  assert.equal(
    normalizeWebhookUrl("abc123def456abc123def456", "wecom"),
    "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123def456abc123def456",
  );
  assert.equal(
    normalizeWebhookUrl("abc123def456abc123def456", "feishu"),
    "https://open.feishu.cn/open-apis/bot/v2/hook/abc123def456abc123def456",
  );
  // 通用渠道不认识 token，原样保留（让用户自己写全）
  assert.equal(normalizeWebhookUrl(token, "generic"), token);
});

test("normalizeWebhookUrl：完整地址不动，缺协议头补 https", () => {
  const full = "https://oapi.dingtalk.com/robot/send?access_token=x";
  assert.equal(normalizeWebhookUrl(full, "dingtalk"), full);
  assert.equal(
    normalizeWebhookUrl("oapi.dingtalk.com/robot/send?access_token=x", "dingtalk"),
    `https://${"oapi.dingtalk.com/robot/send?access_token=x"}`,
  );
  assert.equal(normalizeWebhookUrl("  ", "dingtalk"), "");
  assert.equal(normalizeWebhookUrl("https://example.com/hook", "generic"), "https://example.com/hook");
});
