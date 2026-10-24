/**
 * 纯逻辑单元测试（不依赖 workerd）：
 *   node --experimental-strip-types tests/schedule.test.ts
 */
import assert from "node:assert/strict";
import { parseTimeOfDay, nextDaily, nextWindow, computeNextRun, formatTimeOfDay } from "../src/schedule/time.ts";
import { defaultName, parseTrigger, renameForTarget, tokenize } from "../src/schedule/dsl.ts";
import type { Target } from "../src/types.ts";
import {
  resolveEntity,
  flattenButtons,
  selectButton,
  describeButtons,
  targetRef,
  inputPeerFromTarget,
} from "../src/telegram/executor.ts";
import { createTgClientOnDc, migrateDcFromError, DC_SEEDS } from "../src/telegram/client.ts";
import { messageTargetHint, usernameFromLink } from "../src/telegram/targets.ts";

let passed = 0;
const failures: string[] = [];
const cases: Array<[string, () => void | Promise<void>]> = [];

function test(name: string, fn: () => void | Promise<void>) {
  cases.push([name, fn]);
}

const TZ = 8;
const DAY = 86_400_000;

// ---------------------------------------------------------------- 时间解析
test("parseTimeOfDay 各种写法", () => {
  assert.deepEqual(parseTimeOfDay("9.30"), { hour: 9, minute: 30 });
  assert.deepEqual(parseTimeOfDay("09:30"), { hour: 9, minute: 30 });
  assert.deepEqual(parseTimeOfDay("21：05"), { hour: 21, minute: 5 });
  assert.deepEqual(parseTimeOfDay("0930"), { hour: 9, minute: 30 });
  assert.deepEqual(parseTimeOfDay("2359"), { hour: 23, minute: 59 });
  assert.equal(parseTimeOfDay("2400"), null);
  assert.equal(parseTimeOfDay("签到"), null);
  assert.equal(formatTimeOfDay(9, 5), "09:05");
});

test("nextDaily 取今天的未来时刻", () => {
  // 2026-10-24T00:00:00+08:00
  const now = Date.UTC(2026, 9, 23, 16, 0, 0);
  const next = nextDaily("09:30", now, TZ);
  assert.equal(next, Date.UTC(2026, 9, 24, 1, 30, 0));
});

test("nextDaily 过了今天时间点就顺延到明天", () => {
  // 2026-10-24T10:00:00+08:00
  const now = Date.UTC(2026, 9, 24, 2, 0, 0);
  const next = nextDaily("09:30", now, TZ);
  assert.equal(next, Date.UTC(2026, 9, 25, 1, 30, 0));
  assert.equal(next - now, DAY - 30 * 60_000);
});

test("nextWindow 落在窗口内且用注入的随机函数", () => {
  const now = Date.UTC(2026, 9, 23, 16, 0, 0); // 00:00 +08
  const next = nextWindow("09:00", "10:00", now, TZ, (min, max) => (max <= 0 ? 0 : Math.floor((max - min) / 2)));
  const localHour = new Date(next + TZ * 3_600_000).getUTCHours();
  assert.equal(localHour, 9);
});

test("窗口模式：执行完之后必须跳到下一个窗口（不能几秒后又跑）", () => {
  // 2026-10-24 08:45 +08：正处于 08:30–10:00 的窗口内
  const now = Date.UTC(2026, 9, 24, 0, 45, 0);
  const schedule = { kind: "window" as const, time: "08:30", windowEnd: "10:00" };

  // 刚执行完 → 应该是明天窗口内的某个时刻
  const next = computeNextRun(schedule, now, TZ, { afterExecution: true, random: () => 0 });
  assert.equal(next, Date.UTC(2026, 9, 25, 0, 30, 0)); // 明天 08:30

  // 新建任务（还没跑过）→ 允许落在今天窗口剩余时间内
  const first = computeNextRun(schedule, now, TZ, { random: () => 0 });
  assert.equal(first, now + 5_000);
});

test("窗口模式：随机点覆盖整个窗口，而不是只有前一小时", () => {
  // 03:00 +08 建任务，窗口 08:30–12:00（3.5 小时）
  const now = Date.UTC(2026, 9, 23, 19, 0, 0);
  const schedule = { kind: "window" as const, time: "08:30", windowEnd: "12:00" };
  const latest = computeNextRun(schedule, now, TZ, { random: (_min, max) => max });
  const local = new Date(latest + TZ * 3_600_000);
  assert.equal(local.getUTCHours(), 12);
  assert.equal(local.getUTCMinutes(), 0);
});

test("computeNextRun interval + jitter", () => {
  const now = Date.UTC(2026, 9, 24, 0, 0, 0);
  const plain = computeNextRun({ kind: "interval", intervalMinutes: 30 }, now, TZ, { withoutJitter: true });
  assert.equal(plain - now, 30 * 60_000);
  const jittered = computeNextRun({ kind: "interval", intervalMinutes: 30, jitterSeconds: 60 }, now, TZ, {
    random: () => 30,
  });
  assert.equal(jittered - now, 30 * 60_000 + 30_000);
});

// ---------------------------------------------------------------- 触发解析
test("tokenize 支持引号与全角引号", () => {
  assert.deepEqual(tokenize('9.30 "早上好 各位" btn:签到'), ["9.30", "早上好 各位", "btn:签到"]);
  assert.deepEqual(tokenize("9.30 “晚上好 各位”"), ["9.30", "晚上好 各位"]);
});

const bot: Target = { kind: "user", id: "jerry_bot", username: "jerry_bot" };

test("最简触发：9.30 签到（目标来自转发）", () => {
  const parsed = parseTrigger("9.30 签到", { forwarded: bot });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const task = parsed.result.task!;
  assert.deepEqual(task.schedule, { kind: "daily", time: "09:30", jitterSeconds: 0 });
  assert.deepEqual(task.steps, [{ type: "text", text: "签到" }]);
  assert.equal(task.target.id, "jerry_bot");
  assert.equal(task.source, "trigger");
});

test("默认步骤间隔 3 秒，可用 #delay 覆盖", () => {
  const plain = parseTrigger("9.30 签到 btn:签到 @b", {});
  assert.equal(plain.ok, true);
  if (plain.ok) assert.equal(plain.result.task!.stepDelaySeconds, 3);

  const custom = parseTrigger("9.30 签到 btn:签到 #delay:8 @b", {});
  assert.equal(custom.ok, true);
  if (custom.ok) assert.equal(custom.result.task!.stepDelaySeconds, 8);

  const off = parseTrigger("9.30 签到 btn:签到 #delay:0 @b", {});
  assert.equal(off.ok, true);
  if (off.ok) assert.equal(off.result.task!.stepDelaySeconds, 0);
});

test("自动生成的任务名标记 autoName（写了 #name: 就不是自动的）", () => {
  const auto = parseTrigger("9.30 签到 @b", {});
  assert.equal(auto.ok, true);
  if (auto.ok) assert.equal(auto.result.autoName, true);

  const explicit = parseTrigger("9.30 签到 #name:我的任务 @b", {});
  assert.equal(explicit.ok, true);
  if (explicit.ok) {
    assert.equal(explicit.result.autoName, false);
    assert.equal(explicit.result.task!.name, "我的任务");
  }
});

test("目标补全显示名后，自动生成的任务名同步替换", () => {
  const oldTarget: Target = { kind: "user", id: "qfyun_bot", username: "qfyun_bot" };
  const newTarget: Target = { kind: "user", id: "7066845482", username: "qfyun_bot", title: "签到小助手" };
  assert.equal(renameForTarget("@qfyun_bot /sign", oldTarget, newTarget), "签到小助手 /sign");
  // 用户自己起的名字不动
  assert.equal(renameForTarget("每天签到", oldTarget, newTarget), "每天签到");
  // 没有拿到显示名就不改
  assert.equal(renameForTarget("@qfyun_bot /sign", oldTarget, { ...oldTarget, id: "1" }), "@qfyun_bot /sign");
  // 标签没变也不改
  assert.equal(renameForTarget("@qfyun_bot /sign", oldTarget, { ...oldTarget, title: undefined }), "@qfyun_bot /sign");
});

test("defaultName 用补全后的目标生成名字", () => {
  const steps = [{ type: "text" as const, text: "/sign" }];
  assert.equal(defaultName({ kind: "user", id: "1", username: "qfyun_bot" }, "", steps), "@qfyun_bot /sign");
  assert.equal(
    defaultName({ kind: "user", id: "1", username: "qfyun_bot", title: "签到小助手" }, "", steps),
    "签到小助手 /sign",
  );
});

test("时间可以写在链接/目标后面", () => {
  const withLink = parseTrigger("https://t.me/sheeridvn_bot 9 /start btn:个人信息 btn:签到", {});
  assert.equal(withLink.ok, true);
  if (!withLink.ok) return;
  const task = withLink.result.task!;
  assert.deepEqual(task.schedule, { kind: "daily", time: "09:00", jitterSeconds: 0 });
  assert.equal(task.target.username, "sheeridvn_bot");
  assert.deepEqual(task.steps, [
    { type: "text", text: "/start" },
    { type: "click", text: "个人信息" },
    { type: "click", text: "签到" },
  ]);

  const handleFirst = parseTrigger("@sheeridvn_bot 9.30 签到", {});
  assert.equal(handleFirst.ok, true);
  if (!handleFirst.ok) return;
  assert.equal(handleFirst.result.task!.schedule.time, "09:30");
  assert.equal(handleFirst.result.task!.target.username, "sheeridvn_bot");
  assert.deepEqual(handleFirst.result.task!.steps, [{ type: "text", text: "签到" }]);
});

test("按钮流水线：/start → 个人信息 → 签到", () => {
  const parsed = parseTrigger("9 /start btn:个人信息 btn:签到", { defaultTarget: "@jerry_bot" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const task = parsed.result.task!;
  assert.deepEqual(task.schedule, { kind: "daily", time: "09:00", jitterSeconds: 0 });
  assert.deepEqual(task.steps, [
    { type: "text", text: "/start" },
    { type: "click", text: "个人信息" },
    { type: "click", text: "签到" },
  ]);
});

test("多步骤：发送 + 点按钮 + 等待 + 关键词", () => {
  const parsed = parseTrigger("9.30 签到 btn:立即签到 wait:3 #kw:签到成功|今日已签到 #jitter:120 #delete:30 @x_bot", {});
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const task = parsed.result.task!;
  assert.deepEqual(task.steps, [
    { type: "text", text: "签到" },
    { type: "click", text: "立即签到" },
    { type: "wait", seconds: 3 },
  ]);
  assert.deepEqual(task.successKeywords, ["签到成功", "今日已签到"]);
  assert.equal(task.schedule.jitterSeconds, 120);
  assert.equal(task.deleteAfterSeconds, 30);
  assert.equal(task.target.username, "x_bot");
});

test("按行列点按钮 + 发数字", () => {
  const parsed = parseTrigger("9.30 btn:0,1 num:2 @b", {});
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.result.task!.steps, [
    { type: "click", row: 0, column: 1 },
    { type: "number", value: "2" },
  ]);
});

test("窗口 + 随机消息（每天一条随机内容）", () => {
  const parsed = parseTrigger("8.30-9.30 rand:早上好|午安|晚上好 @group_bot", {});
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const task = parsed.result.task!;
  assert.deepEqual(task.schedule, { kind: "window", time: "08:30", windowEnd: "09:30", jitterSeconds: 0 });
  assert.deepEqual(task.steps, [{ type: "random", options: ["早上好", "午安", "晚上好"] }]);
});

test("间隔任务：每2小时 / every30m / 2h", () => {
  for (const [text, minutes] of [
    ["每2小时 打卡 @b", 120],
    ["每30分 打卡 @b", 30],
    ["every30m 打卡 @b", 30],
    ["2h 打卡 @b", 120],
  ] as Array<[string, number]>) {
    const parsed = parseTrigger(text, {});
    assert.equal(parsed.ok, true, text);
    if (!parsed.ok) continue;
    assert.deepEqual(parsed.result.task!.schedule, {
      kind: "interval",
      intervalMinutes: minutes,
      jitterSeconds: 0,
    });
  }
});

test("一次性任务：#once", () => {
  const parsed = parseTrigger("9.30 once 签到 @b", {});
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.result.task!.schedule.kind, "once");
});

test("带空格文本需要引号", () => {
  const parsed = parseTrigger('9.30 "签到 打卡" @b', {});
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.result.task!.steps, [{ type: "text", text: "签到 打卡" }]);
});

test("带 emoji/空格的文本：引号、全角引号、不引号都行", () => {
  const variants = ['9.00 "📅 每日签到"', "9.00 “📅 每日签到”", "9.00 '📅 每日签到'", "9.00 📅 每日签到"];
  for (const text of variants) {
    const parsed = parseTrigger(text, { defaultTarget: "@b" });
    assert.equal(parsed.ok, true, text);
    if (!parsed.ok) continue;
    assert.equal(parsed.result.task!.schedule.time, "09:00");
    assert.deepEqual(parsed.result.task!.steps, [{ type: "text", text: "📅 每日签到" }], text);
  }
});

test("按钮文本里带空格：btn:\"…\" 取值正确", () => {
  const parsed = parseTrigger('9.00 btn:"📅 每日签到"', { defaultTarget: "@b" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.result.task!.steps, [{ type: "click", text: "📅 每日签到" }]);
});

test("未加引号的连续词会拼成一句话", () => {
  const parsed = parseTrigger("9.30 今日 签到 @b", {});
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.result.task!.steps, [{ type: "text", text: "今日 签到" }]);
});

test("缺时间 / 缺动作 / 缺目标 都要报错", () => {
  const noTime = parseTrigger("签到", { forwarded: bot });
  assert.equal(noTime.ok, false);

  const noAction = parseTrigger("9.30", { forwarded: bot });
  assert.equal(noAction.ok, false);

  const noTarget = parseTrigger("9.30 签到", {});
  assert.equal(noTarget.ok, false);
});

test("命令解析", () => {
  const list = parseTrigger("列表", {});
  assert.equal(list.ok, true);
  if (list.ok) assert.equal(list.result.kind, "list");

  const run = parseTrigger("立即 2", {});
  assert.equal(run.ok, true);
  if (run.ok) {
    assert.equal(run.result.kind, "run");
    assert.equal(run.result.argument, "2");
  }

  const del = parseTrigger("删除 测试签到", {});
  assert.equal(del.ok, true);
  if (del.ok) {
    assert.equal(del.result.kind, "delete");
    assert.equal(del.result.argument, "测试签到");
  }
});

test("任务名优先用群名/机器人显示名，而不是 username", () => {
  const parsed = parseTrigger("9.30 签到", {
    forwarded: { kind: "user", id: "8045138039", username: "sheeridvn_bot", title: "SheerID VN Bot" },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.result.task!.name, "SheerID VN Bot 签到");
  assert.match(parsed.result.explanation || "", /SheerID VN Bot/);

  // 没有显示名时退回 @username
  const noTitle = parseTrigger("9.30 签到", {
    forwarded: { kind: "user", id: "1", username: "jerry_bot" },
  });
  assert.equal(noTitle.ok, true);
  if (noTitle.ok) assert.equal(noTitle.result.task!.name, "@jerry_bot 签到");
});

test("@here 表示发到当前会话（群组/频道）", () => {
  const here: Target = { kind: "channel", id: "-1001234567890", title: "摸鱼群" };
  const parsed = parseTrigger("9.30 打卡 @here", { sourceChat: here });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.result.task!.target.id, "-1001234567890");
  assert.equal(parsed.result.task!.target.kind, "channel");

  // 显式目标优先于 @here
  const explicit = parseTrigger("9.30 打卡 @here @jerry_bot", { sourceChat: here });
  assert.equal(explicit.ok, true);
  if (explicit.ok) assert.equal(explicit.result.task!.target.username, "jerry_bot");

  // 没有 sourceChat 时给出明确提示
  const missing = parseTrigger("9.30 打卡 @here", {});
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /@here/);
});

test("群组/频道目标：数字 id 与 @username 都认", () => {
  const byId = parseTrigger("9.30 打卡 @here", {
    sourceChat: { kind: "chat", id: "-42", title: "普通群" },
  });
  assert.equal(byId.ok, true);
  if (byId.ok) {
    assert.equal(byId.result.task!.target.id, "-42");
    assert.equal(byId.result.task!.target.kind, "chat");
  }

  const byChannel = parseTrigger("9.30 打卡 到:-1001234567890", {});
  assert.equal(byChannel.ok, true);
  if (byChannel.ok) {
    assert.equal(byChannel.result.task!.target.id, "-1001234567890");
    assert.equal(byChannel.result.task!.target.kind, "channel");
  }

  const byUsername = parseTrigger("9.30 打卡 @mychannel", {});
  assert.equal(byUsername.ok, true);
  if (byUsername.ok) {
    assert.equal(byUsername.result.task!.target.username, "mychannel");
    assert.equal(byUsername.result.task!.target.kind, "user");
  }
});

test("默认目标兜底", () => {
  const parsed = parseTrigger("9.30 签到", { defaultTarget: "-1001234567890" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.result.task!.target.id, "-1001234567890");
  assert.equal(parsed.result.task!.target.kind, "channel");
});

// ---------------------------------------------------------------- 按钮解析
function fakeMessage(replyMarkup: unknown) {
  return { replyMarkup } as never;
}

test("flattenButtons 解析 inline 回调/链接按钮", () => {
  const message = fakeMessage({
    className: "ReplyInlineMarkup",
    rows: [
      { buttons: [{ className: "KeyboardButtonCallback", text: "签到", data: new Uint8Array([1, 2, 3]) }] },
      {
        buttons: [
          { className: "KeyboardButtonUrl", text: "官网", url: "https://example.com" },
          { className: "KeyboardButtonCallback", text: "立即签到", data: new Uint8Array([9]) },
        ],
      },
    ],
  });
  const buttons = flattenButtons(message);
  assert.equal(buttons.length, 3);
  assert.deepEqual(
    buttons.map((button) => [button.row, button.column, button.text, button.kind]),
    [
      [0, 0, "签到", "callback"],
      [1, 0, "官网", "url"],
      [1, 1, "立即签到", "callback"],
    ],
  );
  assert.deepEqual([...buttons[0].data!], [1, 2, 3]);
  assert.match(describeButtons(buttons), /立即签到/);
});

test("flattenButtons 解析普通键盘（reply keyboard）", () => {
  const buttons = flattenButtons(
    fakeMessage({
      className: "ReplyKeyboardMarkup",
      rows: [{ buttons: [{ className: "KeyboardButton", text: "确认" }] }],
    }),
  );
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].kind, "text");
});

test("flattenButtons：layer 232 的 ButtonTypeDefault 普通键盘按钮要按文本发送", () => {
  // 线上真实结构：KeyboardButton { text, type: ButtonTypeDefault } —— 没有 data/url
  const buttons = flattenButtons(
    fakeMessage({
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
  assert.equal(buttons.length, 2);
  assert.deepEqual(
    buttons.map((button) => [button.text, button.kind, button.typeClassName]),
    [
      ["👤 个人资料", "text", "ButtonTypeDefault"],
      ["🅰 语言", "text", "ButtonTypeDefault"],
    ],
  );
  assert.equal(selectButton(buttons, { type: "click", text: "个人资料" })?.text, "👤 个人资料");
});

test("flattenButtons：layer 232 的 KeyboardInlineButton 回调按钮要能点", () => {
  const buttons = flattenButtons(
    fakeMessage({
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
      ],
    }),
  );
  assert.equal(buttons[0].kind, "callback");
  assert.deepEqual([...buttons[0].data!], [1, 2, 3]);
  assert.equal(buttons[1].kind, "url");
  assert.equal(buttons[1].url, "https://t.me/sheeridvn");
});

test("flattenButtons 对没有按钮的消息返回空", () => {
  assert.deepEqual(flattenButtons(fakeMessage(undefined)), []);
  assert.deepEqual(flattenButtons(fakeMessage({ className: "ReplyKeyboardHide" })), []);
});

test("selectButton：精确 > 包含 > 不区分大小写 > 行列", () => {
  const buttons = flattenButtons(
    fakeMessage({
      className: "ReplyInlineMarkup",
      rows: [
        { buttons: [{ className: "KeyboardButtonCallback", text: "Check In", data: new Uint8Array([1]) }] },
        {
          buttons: [
            { className: "KeyboardButtonCallback", text: "立即签到", data: new Uint8Array([2]) },
            { className: "KeyboardButtonCallback", text: "签到记录", data: new Uint8Array([3]) },
          ],
        },
      ],
    }),
  );
  assert.equal(selectButton(buttons, { type: "click", text: "立即签到" })?.column, 0);
  assert.equal(selectButton(buttons, { type: "click", text: "记录" })?.text, "签到记录");
  assert.equal(selectButton(buttons, { type: "click", text: "check in" })?.text, "Check In");
  assert.equal(selectButton(buttons, { type: "click", row: 1, column: 1 })?.text, "签到记录");
  assert.equal(selectButton(buttons, { type: "click", text: "不存在" }), null);
});

// ---------------------------------------------------------------- DC 迁移
test("migrateDcFromError 只认 PHONE/NETWORK_MIGRATE_n", () => {
  assert.equal(migrateDcFromError({ errorMessage: "PHONE_MIGRATE_5" }), 5);
  assert.equal(migrateDcFromError({ errorMessage: "NETWORK_MIGRATE_2" }), 2);
  assert.equal(migrateDcFromError({ errorMessage: "PHONE_CODE_INVALID" }), null);
  assert.equal(migrateDcFromError(new Error("PHONE_MIGRATE_4")), 4);
  assert.equal(migrateDcFromError(null), null);
});

test("createTgClientOnDc 会把 session 固定到目标 DC（auth key 在该 DC 重新协商）", () => {
  const client = createTgClientOnDc({ apiId: 1, apiHash: "x" }, 5);
  assert.equal(client.session.dcId, 5);
  assert.equal(client.session.serverAddress, DC_SEEDS[5]);
  assert.equal(client.session.port, 443);
  assert.equal(client.session.authKey, undefined);
});

// ---------------------------------------------------------------- 目标推断
test("目标推断：转发来源优先", () => {
  const hint = messageTargetHint({
    out: true,
    message: "9.30 签到",
    fwdFrom: { fromId: { className: "PeerUser", userId: 7363239 } },
  });
  assert.deepEqual(hint, { kind: "peer", peer: { className: "PeerUser", userId: 7363239 } });
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
  // 触发消息本身是我发的 → 不看发送者
  assert.equal(messageTargetHint(botMessage, { allowSender: false }), null);
  // 被回复的消息 → 发送者就是机器人（标记 fromSender，Agent 会再校验 bot 标志）
  assert.deepEqual(messageTargetHint(botMessage, { allowSender: true }), {
    kind: "peer",
    peer: { className: "PeerUser", userId: 555 },
    fromSender: true,
  });
  // 我自己发的转发副本不进"发送者"分支
  assert.equal(messageTargetHint({ ...botMessage, out: true }, { allowSender: true }), null);
});

test("目标推断：t.me 链接与 @username", () => {
  assert.equal(usernameFromLink("https://t.me/jerry_bot"), "jerry_bot");
  assert.equal(usernameFromLink("t.me/jerry_bot?start=1"), "jerry_bot");
  assert.equal(usernameFromLink("@jerry_bot"), "jerry_bot");
  assert.equal(usernameFromLink("https://example.com"), null);
  const text = "https://t.me/jerry_bot";
  assert.deepEqual(
    messageTargetHint({
      message: text,
      entities: [{ className: "MessageEntityUrl", offset: 0, length: text.length }],
    }),
    { kind: "username", value: "jerry_bot" },
  );
});

test("目标推断：没有线索时返回 null", () => {
  assert.equal(messageTargetHint({ out: true, message: "9.30 签到" }), null);
});

// ---------------------------------------------------------------- 目标解析
test("targetRef：同时有 username 和数字 id 时优先 username", () => {
  // 数字 id 解析需要 access_hash，新连接可能拿不到 → 报 Could not find the input entity
  assert.equal(targetRef({ kind: "user", id: "8045138039", username: "sheeridvn_bot" }), "@sheeridvn_bot");
  assert.equal(targetRef({ kind: "user", id: "8045138039" }), "8045138039");
  assert.equal(targetRef({ kind: "channel", id: "-1001234567890", username: "channel_name" }), "@channel_name");
  assert.equal(targetRef({ kind: "channel", id: "-1001234567890" }), "-1001234567890");
  assert.equal(targetRef("me"), "me");
  assert.equal(targetRef("@foo_bot"), "@foo_bot");
});

test("inputPeerFromTarget：有 access_hash 才能构造出 InputPeer", () => {
  assert.equal(inputPeerFromTarget({ kind: "user", id: "8045138039" }), null);
  const user = inputPeerFromTarget({ kind: "user", id: "8045138039", accessHash: "1234567890123456789" });
  assert.equal(user?.className, "InputPeerUser");
  assert.equal(String((user as { userId?: unknown }).userId), "8045138039");

  const channel = inputPeerFromTarget({ kind: "channel", id: "-1001234567890", accessHash: "42" });
  assert.equal(channel?.className, "InputPeerChannel");
  assert.equal(String((channel as { channelId?: unknown }).channelId), "1234567890");

  const chat = inputPeerFromTarget({ kind: "chat", id: "-42", accessHash: "7" });
  assert.equal(chat?.className, "InputPeerChat");
});

// ---------------------------------------------------------------- 实体解析（异步）
test("resolveEntity：数字 id 解析失败时先 getDialogs 预热再重试", async () => {
  const calls: string[] = [];
  let warmed = false;
  const client = {
    getEntity: async (value: unknown) => {
      const key = typeof value === "string" ? value : String((value as { className?: string })?.className);
      calls.push(`getEntity:${key}`);
      if (!warmed) throw new Error("Could not find the input entity for {\"userId\":\"8045138039\"}");
      return { className: "User", id: "8045138039" };
    },
    getDialogs: async () => {
      calls.push("getDialogs");
      warmed = true;
      return [];
    },
  } as unknown as Parameters<typeof resolveEntity>[0];

  const entity = await resolveEntity(client, { kind: "user", id: "8045138039" });
  assert.equal((entity as { id?: string }).id, "8045138039");
  assert.deepEqual(calls, ["getEntity:8045138039", "getDialogs", "getEntity:8045138039"]);
});

test("resolveEntity：预热后仍失败时报可操作的错误", async () => {
  const client = {
    getEntity: async () => {
      throw new Error("Could not find the input entity for 1");
    },
    getDialogs: async () => [],
  } as unknown as Parameters<typeof resolveEntity>[0];

  await assert.rejects(() => resolveEntity(client, { kind: "user", id: "1" }), /无法解析目标/);
});

// ---------------------------------------------------------------- 结果
(async () => {
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed++;
    } catch (error) {
      failures.push(`${name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) {
    console.error(`✗ ${failures.length} 个用例失败 / ${passed + failures.length}`);
    for (const failure of failures) console.error(`  · ${failure}`);
    process.exit(1);
  }
  console.log(`✓ ${passed} 个用例通过`);
})();
