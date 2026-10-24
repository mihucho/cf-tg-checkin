/** 触发语法：时间/动作/修饰符/目标/命令/前缀（正例 + 反例） */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import type { Target } from "../src/types";
import {
  defaultName,
  findTimeToken,
  parseTrigger,
  renameForTarget,
  stripTriggerPrefix,
  tokenize,
} from "../src/schedule/dsl.ts";

const bot: Target = { kind: "user", id: "example_bot", username: "example_bot" };

function parse(text: string, ctx: Parameters<typeof parseTrigger>[1] = {}) {
  const result = parseTrigger(text, ctx);
  assert.equal(result.ok, true, result.ok ? "" : `解析失败：${result.error}`);
  if (!result.ok) throw new Error("unreachable");
  return result.result;
}

function parseError(text: string, ctx: Parameters<typeof parseTrigger>[1] = {}): string {
  const result = parseTrigger(text, ctx);
  assert.equal(result.ok, false, `应当解析失败：${text}`);
  if (result.ok) throw new Error("unreachable");
  return result.error;
}

// ---------------------------------------------------------------- 分词
test("tokenize：引号 / 全角引号 / 无引号空格", () => {
  assert.deepEqual(tokenize('9.30 "早上好 各位" btn:签到'), ["9.30", "早上好 各位", "btn:签到"]);
  assert.deepEqual(tokenize("9.30 “晚上好 各位”"), ["9.30", "晚上好 各位"]);
  assert.deepEqual(tokenize("  9.30   签到  "), ["9.30", "签到"]);
  assert.deepEqual(tokenize(""), []);
});

// ---------------------------------------------------------------- 时间位置
test("时间可以出现在任意位置", () => {
  const withLink = parse("https://t.me/example_bot 9 /start btn:个人信息 btn:签到", {});
  assert.equal(withLink.task!.schedule.time, "09:00");
  assert.equal(withLink.task!.target.username, "example_bot");
  assert.deepEqual(withLink.task!.steps.map((s) => s.type), ["text", "click", "click"]);

  const handleFirst = parse("@example_bot 9.30 签到", {});
  assert.equal(handleFirst.task!.schedule.time, "09:30");
  assert.deepEqual(handleFirst.task!.steps, [{ type: "text", text: "签到" }]);
});

test("findTimeToken：没时间表达式时返回 null", () => {
  assert.equal(findTimeToken(tokenize("签到")), null);
  assert.equal(findTimeToken(tokenize("btn:签到 num:2")), null);
  assert.equal(findTimeToken(tokenize("明天 买牛奶")), null);
});

// ---------------------------------------------------------------- 时间
test("时间写法：daily / window / interval", () => {
  assert.deepEqual(parse("9.30 签到 @b", {}).task!.schedule, {
    kind: "daily",
    time: "09:30",
    jitterSeconds: 0,
  });
  assert.deepEqual(parse("8.30-9.30 签到 @b", {}).task!.schedule, {
    kind: "window",
    time: "08:30",
    windowEnd: "09:30",
    jitterSeconds: 0,
  });
  assert.deepEqual(parse("每2小时 打卡 @b", {}).task!.schedule, {
    kind: "interval",
    intervalMinutes: 120,
    jitterSeconds: 0,
  });
  assert.deepEqual(parse("2h 打卡 @b", {}).task!.schedule, {
    kind: "interval",
    intervalMinutes: 120,
    jitterSeconds: 0,
  });
});

// ---------------------------------------------------------------- 动作
test("动作流水线：文本 + 点按钮 + 等待 + 随机 + 数字", () => {
  const task = parse('9.30 签到 btn:"📅 每日签到" wait:3 rand:早安|午安 num:2 @b', {}).task!;
  assert.deepEqual(task.steps, [
    { type: "text", text: "签到" },
    { type: "click", text: "📅 每日签到" },
    { type: "wait", seconds: 3 },
    { type: "random", options: ["早安", "午安"] },
    { type: "number", value: "2" },
  ]);
});

test("动作反例：空文本/缺时间/缺动作都要报错", () => {
  assert.match(parseError("签到", { forwarded: bot }), /缺少时间/);
  assert.match(parseError("9.30", { forwarded: bot }), /缺少动作/);
  assert.match(parseError("9.30 签到", {}), /找不到签到目标/);
});

test("带 emoji/空格的文本：引号与不引号等价", () => {
  for (const text of ['9.00 "📅 每日签到"', "9.00 “📅 每日签到”", "9.00 📅 每日签到"]) {
    assert.deepEqual(parse(text, { defaultTarget: "bot" }).task!.steps, [{ type: "text", text: "📅 每日签到" }], text);
  }
});

// ---------------------------------------------------------------- 修饰符
test("修饰符：#kw / #delay / #jitter / #delete / #timeout / #thread / #once / #name", () => {
  const task = parse(
    "9.30 签到 #kw:成功|已签到 #delay:8 #jitter:120 #delete:30 #timeout:40 #thread:12 #name:我的任务 @b",
    {},
  ).task!;
  assert.deepEqual(task.successKeywords, ["成功", "已签到"]);
  assert.equal(task.stepDelaySeconds, 8);
  assert.equal(task.schedule.jitterSeconds, 120);
  assert.equal(task.deleteAfterSeconds, 30);
  assert.equal(task.timeoutSeconds, 40);
  assert.equal(task.threadId, 12);
  assert.equal(task.name, "我的任务");

  const once = parse("9.30 once 签到 @b", {}).task!;
  assert.equal(once.schedule.kind, "once");
});

test("修饰符默认值：delay 3 / timeout 30 / jitter 0", () => {
  const task = parse("9.30 签到 @b", {}).task!;
  assert.equal(task.stepDelaySeconds, 3);
  assert.equal(task.timeoutSeconds, 30);
  assert.equal(task.schedule.jitterSeconds, 0);
});

test("cleanupPrevious 默认开启，#keep 关闭，#clean 显式开启", () => {
  assert.equal(parse("9.30 签到 @b", {}).task!.cleanupPrevious, true);
  assert.equal(parse("9.30 签到 #keep @b", {}).task!.cleanupPrevious, false);
  assert.equal(parse("9.30 签到 #clean @b", {}).task!.cleanupPrevious, true);
});

// ---------------------------------------------------------------- 目标
test("目标优先级：显式 > @here > 转发 > 默认", () => {
  const here: Target = { kind: "channel", id: "-100123", title: "群" };
  assert.equal(parse("9.30 打卡 @here", { sourceChat: here }).task!.target.id, "-100123");
  assert.equal(
    parse("9.30 打卡 @here @jerry_bot", { sourceChat: here }).task!.target.username,
    "jerry_bot",
  );
  assert.equal(parse("9.30 打卡", { forwarded: bot }).task!.target.username, "example_bot");
  assert.equal(parse("9.30 打卡", { defaultTarget: "-100999" }).task!.target.id, "-100999");
});

test("多目标：到:a|b 与 @a|b", () => {
  const byIds = parse("9.30 签到 到:-1001|@group_b", {}).task!;
  assert.equal(byIds.target.id, "-1001");
  assert.equal(byIds.targets?.length, 2);
  assert.equal(byIds.targets?.[1].username, "group_b");

  const byHandles = parse("9.30 签到 @a_bot|@b_bot", {}).task!;
  assert.deepEqual(byHandles.targets?.map((t) => t.username), ["a_bot", "b_bot"]);

  // 单目标不产生 targets 字段
  assert.equal(parse("9.30 签到 @a_bot", {}).task!.targets, undefined);
});

test("目标话题：#12 后缀只作用于该目标", () => {
  const single = parse("9.30 签到 @group#12", {}).task!;
  assert.equal(single.target.threadId, 12);
  assert.equal(single.threadId, null);

  const multi = parse("9.30 签到 到:@a#12|@b", {}).task!;
  assert.equal(multi.targets?.[0].threadId, 12);
  assert.equal(multi.targets?.[1].threadId, undefined);

  // 全角/无数字都要安全退化
  assert.equal(parse("9.30 签到 @group#", {}).task!.target.threadId, undefined);
  assert.equal(parse("9.30 签到 @group#0", {}).task!.target.threadId, undefined);
});

test("目标反例：@here 没有当前会话时要明确报错", () => {
  assert.match(parseError("9.30 打卡 @here", {}), /@here/);
});

test("任务名：优先显示名，没有才用 @username；#name 覆盖", () => {
  assert.equal(
    parse("9.30 签到", { forwarded: { ...bot, title: "签到小助手" } }).task!.name,
    "签到小助手 签到",
  );
  assert.equal(parse("9.30 签到", { forwarded: bot }).task!.name, "@example_bot 签到");
  assert.equal(parse("9.30 签到 #name:自定义 @b", {}).task!.name, "自定义");
});

test("autoName 标记：只有没写 #name: 才是自动名", () => {
  assert.equal(parse("9.30 签到 @b", {}).autoName, true);
  assert.equal(parse("9.30 签到 #name:x @b", {}).autoName, false);
});

test("renameForTarget：补全显示名后只改自动生成的名字", () => {
  const oldTarget: Target = { kind: "user", id: "example_bot", username: "example_bot" };
  const newTarget: Target = { ...oldTarget, id: "123456789", title: "签到小助手" };
  assert.equal(renameForTarget("@example_bot /sign", oldTarget, newTarget), "签到小助手 /sign");
  assert.equal(renameForTarget("我的任务", oldTarget, newTarget), "我的任务");
  assert.equal(renameForTarget("@example_bot /sign", oldTarget, oldTarget), "@example_bot /sign");
});

test("defaultName：用最终目标生成", () => {
  const steps = [{ type: "text" as const, text: "/sign" }];
  assert.equal(defaultName(bot, "", steps), "@example_bot /sign");
  assert.equal(defaultName({ ...bot, title: "签到小助手" }, "", steps), "签到小助手 /sign");
});

// ---------------------------------------------------------------- 命令
test("管理命令：列表 / 立即 / 开启 / 关闭 / 删除 / 帮助", () => {
  assert.equal(parse("列表", {}).kind, "list");
  assert.deepEqual([parse("立即 2", {}).kind, parse("立即 2", {}).argument], ["run", "2"]);
  assert.deepEqual([parse("开启 2", {}).kind, parse("开启 2", {}).argument], ["enable", "2"]);
  assert.deepEqual([parse("关闭 2", {}).kind, parse("关闭 2", {}).argument], ["disable", "2"]);
  assert.deepEqual([parse("删除 测试签到", {}).kind, parse("删除 测试签到", {}).argument], [
    "delete",
    "测试签到",
  ]);
  assert.equal(parse("帮助", {}).kind, "help");
  // 大小写不敏感
  assert.equal(parse("LIST", {}).kind, "list");
});

// ---------------------------------------------------------------- 前缀
test("stripTriggerPrefix：多种写法匹配", () => {
  assert.deepEqual(stripTriggerPrefix("tg 9.30 签到", "tg"), { matched: true, rest: "9.30 签到" });
  assert.deepEqual(stripTriggerPrefix("/tg 9.30 签到", "/tg"), { matched: true, rest: "9.30 签到" });
  assert.deepEqual(stripTriggerPrefix("TG: 9.30 签到", "tg:"), { matched: true, rest: "9.30 签到" });
  assert.deepEqual(stripTriggerPrefix("   tg   9.30 签到", "tg"), { matched: true, rest: "9.30 签到" });
  assert.deepEqual(stripTriggerPrefix("9.30 签到", ""), { matched: true, rest: "9.30 签到" });
});

test("stripTriggerPrefix：不带前缀不匹配（反例）", () => {
  assert.deepEqual(stripTriggerPrefix("明天买牛奶", "tg"), { matched: false, rest: "明天买牛奶" });
  assert.deepEqual(stripTriggerPrefix("9.30 签到", "tg"), { matched: false, rest: "9.30 签到" });
  assert.deepEqual(stripTriggerPrefix("", "tg"), { matched: false, rest: "" });
});
