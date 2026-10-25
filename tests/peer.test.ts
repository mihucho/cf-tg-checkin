/** 目标类型识别 + 取「最后一步之后对方回的第一条」 */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { classifyPeer, pickFirstPeerReply } from "../src/telegram/executor.ts";

test("classifyPeer：机器人 / 用户 / 群组 / 频道", () => {
  assert.equal(classifyPeer({ className: "User", bot: true }), "bot");
  assert.equal(classifyPeer({ className: "User", bot: false }), "user");
  assert.equal(classifyPeer({ className: "User" }), "user");
  assert.equal(classifyPeer({ className: "Chat" }), "group");
  assert.equal(classifyPeer({ className: "Channel", megagroup: true }), "group");
  assert.equal(classifyPeer({ className: "Channel", broadcast: true }), "channel");
  // 已经解析成 TL 原始结构时只有 _ 字段
  assert.equal(classifyPeer({ _: "channel", megagroup: true }), "group");
  assert.equal(classifyPeer(undefined), "user");
});

test("pickFirstPeerReply：取最后一步之后、对方发的第一条", () => {
  const messages = [
    { id: 10, out: true, message: "我自己发的" },
    { id: 12, out: false, message: "机器人回复 1" },
    { id: 13, out: false, message: "机器人回复 2" },
  ];
  assert.deepEqual(pickFirstPeerReply(messages, 11), messages[1]);
  // 只取 afterId 之后的
  assert.deepEqual(pickFirstPeerReply(messages, 12), messages[2]);
  // 全都是自己发的 → 没有回复
  assert.equal(pickFirstPeerReply([{ id: 20, out: true, message: "x" }], 11), null);
  assert.equal(pickFirstPeerReply([], 0), null);
});

test("pickFirstPeerReply：顺序打乱也取 id 最小的那条", () => {
  const messages = [
    { id: 15, out: false, message: "后到的" },
    { id: 12, out: false, message: "先到的" },
  ];
  assert.equal(pickFirstPeerReply(messages, 10)?.message, "先到的");
});

test("pickFirstPeerReply：群组场景（别人发的都算，我自己发的排除）", () => {
  const messages = [
    { id: 30, out: true, message: "我：签到" },
    { id: 31, out: false, message: "群友：今天签过了" },
    { id: 32, out: false, message: "机器人：签到成功" },
  ];
  assert.equal(pickFirstPeerReply(messages, 29)?.message, "群友：今天签过了");
});

/* ---------- 多行回复压成一行（日志是逐行写的） ---------- */

import { oneLine } from "../src/telegram/executor.ts";

test("oneLine：机器人回复的换行折成 /，不把日志拆行", () => {
  assert.equal(oneLine("您已经签到过了！\n当前有 342 点积分"), "您已经签到过了！ / 当前有 342 点积分");
  assert.equal(oneLine("第一行\n\n  第二行  "), "第一行 / 第二行");
  assert.equal(oneLine("单行回复"), "单行回复");
});

test("oneLine：超长截断并带省略号", () => {
  const flat = oneLine("字".repeat(300), 20);
  assert.equal(flat.length, 21);
  assert.ok(flat.endsWith("…"));
});
