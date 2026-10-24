/**
 * 指令往返：`taskToCommand` 生成的指令必须能被 `parseTrigger` 解析回等价任务。
 *
 * 这组用例来自 v0.10.0 的审计：文本以 `#` / `btn:` / 时间 / 链接开头、
 * 随机项与关键词含空格、名称含引号等 9 类内容曾经「复制指令后重建任务」会变形。
 */
import { test } from "./harness.ts";
import { taskToCommand } from "../src/schedule/command.ts";
import { parseTrigger } from "../src/schedule/dsl.ts";
import { normalizeTaskInput } from "../src/task.ts";
import type { TaskInput } from "../src/types.ts";
const base = {
  enabled: true, threadId: null,
  schedule: { kind: "daily" as const, time: "09:30", jitterSeconds: 0 },
  successKeywords: [], timeoutSeconds: 30, stepDelaySeconds: 3,
  deleteAfterSeconds: 0, cleanupPrevious: true, source: "ui" as const,
};

const targetKeys = (list: Array<{ username?: string; id: string; threadId?: number }>) =>
  JSON.stringify(list.map((item) => `${(item.username || item.id).toLowerCase()}#${item.threadId ?? ""}`));

test("审计：危险文本的指令往返（修复后应全部通过）", () => {
  const cases: Array<[string, TaskInput]> = [...extraCases,
    ["文本像时间", mk({ steps: [{ type: "text", text: "9点半" }] })],
    ["文本像时间2", mk({ steps: [{ type: "text", text: "09:30" }] })],
    ["文本像修饰符", mk({ steps: [{ type: "text", text: "#kw:签到成功" }] })],
    ["文本像按钮", mk({ steps: [{ type: "text", text: "btn:签到" }] })],
    ["文本像目标", mk({ steps: [{ type: "text", text: "到:@someone" }] })],
    ["文本是命令词", mk({ steps: [{ type: "text", text: "列表" }] })],
    ["文本是链接", mk({ steps: [{ type: "text", text: "https://t.me/x" }] })],
    ["关键词含空格", mk({ steps: [{ type: "text", text: "签到" }], successKeywords: ["签到 成功", "已签到"] })],
    ["名称含引号", mk({ name: 'a"b', steps: [{ type: "text", text: "签到" }] })],
    ["文本含引号", mk({ steps: [{ type: "text", text: '他说"你好"' }] })],
    ["文本含反斜杠", mk({ steps: [{ type: "text", text: "C:\\path" }] })],
    ["随机项含空格", mk({ steps: [{ type: "random", options: ["早上 好", "午安"] }] })],
    ["文本含竖线", mk({ steps: [{ type: "text", text: "a|b" }] })],
    ["多目标+话题", mk({
      target: { kind: "channel", id: "-1001234567890", username: "group_a", threadId: 12 },
      targets: [
        { kind: "channel", id: "-1001234567890", username: "group_a", threadId: 12 },
        { kind: "user", id: "b_bot", username: "b_bot" },
      ],
      steps: [{ type: "text", text: "签到" }],
    })],
  ];
  const broken: string[] = [];
  for (const [label, input] of cases) {
    const normalized = normalizeTaskInput(input);
    const cmd = taskToCommand(normalized, "tg");
    const parsed = parseTrigger(cmd.replace(/^tg\s+/, ""), { allowMissingTarget: true });
    const rt = parsed.ok && parsed.result.task ? normalizeTaskInput(parsed.result.task) : null;
    const ok =
      rt &&
      JSON.stringify(rt.steps) === JSON.stringify(normalized.steps) &&
      JSON.stringify(rt.successKeywords) === JSON.stringify(normalized.successKeywords) &&
      rt.name === normalized.name &&
      // 指令只带 @username / 数字 id，不保留 accessHash 与 kind，比较时按「句柄 + 话题」比较
      targetKeys(rt.targets ?? []) === targetKeys(normalized.targets ?? []);
    if (!ok) broken.push(`${label} :: ${JSON.stringify(cmd)} → ${JSON.stringify(rt && { steps: rt.steps, kw: rt.successKeywords, name: rt.name })}`);
  }
  if (broken.length) throw new Error(`往返失败 ${broken.length} 项：\n${broken.join("\n")}`);
});

const mk = (over: Partial<TaskInput>): TaskInput => ({
  ...base,
  name: "t",
  target: { kind: "user", id: "a_bot", username: "a_bot" },
  steps: [{ type: "text", text: "签到" }],
  ...over,
});

const extraCases: Array<[string, TaskInput]> = [
  ["名字带井号", { ...base, name: "任务 #kw:x", target: { kind: "user", id: "a_bot", username: "a_bot" }, steps: [{ type: "text", text: "签到" }] }],
  ["文本含换行", { ...base, name: "多行", target: { kind: "user", id: "a_bot", username: "a_bot" }, steps: [{ type: "text", text: "第一行\n第二行" }] }],
  ["文本含修饰符", { ...base, name: "hash", target: { kind: "user", id: "a_bot", username: "a_bot" }, steps: [{ type: "text", text: "签到 #keep" }] }],
  ["随机项含空格", { ...base, name: "rand", target: { kind: "user", id: "a_bot", username: "a_bot" }, steps: [{ type: "random", options: ["早上 好", "午安"] }] }],
  ["按钮含空格", { ...base, name: "btn", target: { kind: "user", id: "a_bot", username: "a_bot" }, steps: [{ type: "text", text: "到" }, { type: "click", text: "个人 资料" }] }],
];
