/** 按钮解析与匹配：layer 232 新结构 / 老结构 / reply keyboard（正反例） */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import {
  flattenButtons,
  selectButton,
  describeButtons,
  buttonSignature,
  normalizeButtonText,
} from "../src/telegram/executor.ts";

function msg(replyMarkup: unknown) {
  return { replyMarkup } as never;
}

test("flattenButtons：layer 232 inline 按钮（KeyboardInlineButton + type）", () => {
  const buttons = flattenButtons(
    msg({
      className: "ReplyInlineMarkup",
      rows: [
        {
          buttons: [
            {
              className: "KeyboardInlineButton",
              text: "✅ Verify SheerID",
              type: { className: "InlineButtonTypeCallback", data: new Uint8Array([1, 2, 3]) },
            },
            {
              className: "KeyboardInlineButton",
              text: "🌐 频道",
              type: { className: "InlineButtonTypeUrl", url: "https://t.me/sheeridvn" },
            },
          ],
        },
        {
          buttons: [
            {
              className: "KeyboardInlineButton",
              text: "📄 文档",
              type: { className: "InlineButtonTypeWebView", url: "https://example.com/doc" },
            },
            {
              className: "KeyboardInlineButton",
              text: "🔎 分享",
              type: { className: "InlineButtonTypeSwitchInline", query: "hi" },
            },
          ],
        },
      ],
    }),
  );

  assert.deepEqual(
    buttons.map((b) => [b.row, b.column, b.kind, b.text]),
    [
      [0, 0, "callback", "✅ Verify SheerID"],
      [0, 1, "url", "🌐 频道"],
      [1, 0, "webview", "📄 文档"],
      [1, 1, "switch", "🔎 分享"],
    ],
  );
  assert.deepEqual([...buttons[0].data!], [1, 2, 3]);
  assert.equal(buttons[1].url, "https://t.me/sheeridvn");
  assert.equal(buttons[3].query, "hi");
});

test("flattenButtons：老结构（data/url 直接在按钮上）", () => {
  const buttons = flattenButtons(
    msg({
      className: "ReplyInlineMarkup",
      rows: [
        {
          buttons: [
            { className: "KeyboardButtonCallback", text: "签到", data: new Uint8Array([9]) },
            { className: "KeyboardButtonUrl", text: "官网", url: "https://example.com" },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(
    buttons.map((b) => [b.kind, b.text]),
    [
      ["callback", "签到"],
      ["url", "官网"],
    ],
  );
});

test("flattenButtons：reply keyboard（ButtonTypeDefault 按文本发送）", () => {
  const buttons = flattenButtons(
    msg({
      className: "ReplyKeyboardMarkup",
      rows: [
        {
          buttons: [
            { className: "KeyboardButton", text: "👤 个人资料", type: { className: "ButtonTypeDefault" } },
            { className: "KeyboardButton", text: "🅰 语言", type: { className: "ButtonTypeDefault" } },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(
    buttons.map((b) => [b.kind, b.text, b.typeClassName]),
    [
      ["text", "👤 个人资料", "ButtonTypeDefault"],
      ["text", "🅰 语言", "ButtonTypeDefault"],
    ],
  );
});

test("flattenButtons：无按钮 / 空 markup 返回空数组（反例）", () => {
  assert.deepEqual(flattenButtons(msg(undefined)), []);
  assert.deepEqual(flattenButtons(msg(null)), []);
  assert.deepEqual(flattenButtons(msg({ className: "ReplyKeyboardHide" })), []);
  assert.deepEqual(flattenButtons(msg({ className: "ReplyInlineMarkup", rows: [] })), []);
});

test("selectButton：精确 > 去图标/空格 > 大小写 > 行列", () => {
  const buttons = flattenButtons(
    msg({
      className: "ReplyInlineMarkup",
      rows: [
        {
          buttons: [
            { className: "KeyboardInlineButton", text: "Check In", type: { className: "InlineButtonTypeCallback", data: new Uint8Array([1]) } },
            { className: "KeyboardInlineButton", text: "👤 个人资料", type: { className: "InlineButtonTypeCallback", data: new Uint8Array([2]) } },
            { className: "KeyboardInlineButton", text: "📅 每日签到", type: { className: "InlineButtonTypeCallback", data: new Uint8Array([3]) } },
          ],
        },
      ],
    }),
  );

  assert.equal(selectButton(buttons, { type: "click", text: "个人资料" })?.text, "👤 个人资料");
  assert.equal(selectButton(buttons, { type: "click", text: "每日签到" })?.text, "📅 每日签到");
  assert.equal(selectButton(buttons, { type: "click", text: "check in" })?.text, "Check In");
  assert.equal(selectButton(buttons, { type: "click", row: 0, column: 2 })?.text, "📅 每日签到");
  assert.equal(selectButton(buttons, { type: "click", text: "不存在" }), null);
  // 行列越界
  assert.equal(selectButton(buttons, { type: "click", row: 5, column: 5 }), null);
});

test("normalizeButtonText：去掉 emoji / 空格 / 标点", () => {
  assert.equal(normalizeButtonText("👤 个人资料"), "个人资料");
  assert.equal(normalizeButtonText("📅 每日 签到！"), "每日签到");
  assert.equal(normalizeButtonText("Check-In"), "checkin");
});

test("buttonSignature：菜单没变时指纹相同，变了则不同", () => {
  const before = flattenButtons(
    msg({
      className: "ReplyInlineMarkup",
      rows: [{ buttons: [{ className: "KeyboardInlineButton", text: "个人资料", type: { className: "InlineButtonTypeCallback", data: new Uint8Array([1]) } }] }],
    }),
  );
  const same = flattenButtons(
    msg({
      className: "ReplyInlineMarkup",
      rows: [{ buttons: [{ className: "KeyboardInlineButton", text: "个人资料", type: { className: "InlineButtonTypeCallback", data: new Uint8Array([1]) } }] }],
    }),
  );
  const changed = flattenButtons(
    msg({
      className: "ReplyInlineMarkup",
      rows: [{ buttons: [{ className: "KeyboardInlineButton", text: "签到", type: { className: "InlineButtonTypeCallback", data: new Uint8Array([2]) } }] }],
    }),
  );
  assert.equal(buttonSignature(before), buttonSignature(same));
  assert.notEqual(buttonSignature(before), buttonSignature(changed));
});

test("describeButtons：带类型与类名，便于排查", () => {
  const buttons = flattenButtons(
    msg({
      className: "ReplyKeyboardMarkup",
      rows: [{ buttons: [{ className: "KeyboardButton", text: "个人资料", type: { className: "ButtonTypeDefault" } }] }],
    }),
  );
  const text = describeButtons(buttons);
  assert.match(text, /\[0,0\] 个人资料/);
  assert.match(text, /text/);
  assert.match(text, /ButtonTypeDefault/);
});
