/** 目标推断：转发/卡片/内联机器人/发送者/链接（正反例） */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { messageTargetHint, usernameFromLink, collectLinks } from "../src/telegram/targets.ts";

test("目标推断：转发来源优先", () => {
  assert.deepEqual(
    messageTargetHint({
      out: true,
      message: "9.30 签到",
      fwdFrom: { fromId: { className: "PeerUser", userId: 7363239 } },
    }),
    { kind: "peer", peer: { className: "PeerUser", userId: 7363239 } },
  );
  // 频道转发
  assert.deepEqual(
    messageTargetHint({ fwdFrom: { fromId: { className: "PeerChannel", channelId: 123 } } }),
    { kind: "peer", peer: { className: "PeerChannel", channelId: 123 } },
  );
});

test("目标推断：联系人卡片 / 内联机器人", () => {
  assert.deepEqual(messageTargetHint({ media: { className: "MessageMediaContact", userId: 42 } }), {
    kind: "peer",
    peer: { className: "PeerUser", userId: 42 },
  });
  assert.deepEqual(messageTargetHint({ viaBotId: 777 }), {
    kind: "peer",
    peer: { className: "PeerUser", userId: 777 },
  });
});

test("目标推断：只有被回复的消息才看发送者", () => {
  const botMessage = { out: false, senderId: { className: "PeerUser", userId: 555 }, message: "签到成功" };
  assert.equal(messageTargetHint(botMessage, { allowSender: false }), null);
  assert.deepEqual(messageTargetHint(botMessage, { allowSender: true }), {
    kind: "peer",
    peer: { className: "PeerUser", userId: 555 },
    fromSender: true,
  });
  // 自己发的转发副本不进"发送者"分支
  assert.equal(messageTargetHint({ ...botMessage, out: true }, { allowSender: true }), null);
});

test("目标推断：t.me 链接与 @username", () => {
  assert.equal(usernameFromLink("https://t.me/jerry_bot"), "jerry_bot");
  assert.equal(usernameFromLink("t.me/jerry_bot?start=1"), "jerry_bot");
  assert.equal(usernameFromLink("https://telegram.me/jerry_bot"), "jerry_bot");
  assert.equal(usernameFromLink("@jerry_bot"), "jerry_bot");
  // 反例：不是聊天链接
  assert.equal(usernameFromLink("https://example.com"), null);
  assert.equal(usernameFromLink("https://t.me/"), null);
  assert.equal(usernameFromLink("https://t.me/joinchat/abc"), null);
});

test("目标推断：无任何线索时返回 null（反例）", () => {
  assert.equal(messageTargetHint({ out: true, message: "9.30 签到" }), null);
  assert.equal(messageTargetHint({}), null);
  assert.equal(messageTargetHint({ message: "https://example.com/article" }), null);
});

test("collectLinks：网页预览 + URL 实体", () => {
  const text = "看这里 https://t.me/example_bot 谢谢";
  const offset = text.indexOf("https://t.me/example_bot");
  const links = collectLinks({
    message: text,
    entities: [{ className: "MessageEntityUrl", offset, length: "https://t.me/example_bot".length }],
  });
  assert.deepEqual(links, ["https://t.me/example_bot"]);

  const withPreview = collectLinks({ media: { webpage: { url: "https://t.me/other_bot" } } });
  assert.deepEqual(withPreview, ["https://t.me/other_bot"]);

  // TextUrl 实体用自己的 url
  assert.deepEqual(
    collectLinks({ message: "文字", entities: [{ className: "MessageEntityTextUrl", url: "https://t.me/x_bot" }] }),
    ["https://t.me/x_bot"],
  );
  // 反例：非 URL 实体不收集
  assert.deepEqual(collectLinks({ message: "文字", entities: [{ className: "MessageEntityBold", offset: 0, length: 2 }] }), []);
});
