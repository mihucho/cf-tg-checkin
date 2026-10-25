/**
 * 文案自检（没有隐私黑名单版本）。
 *
 * 原来在 `scripts/copy-lint.mjs` 里，其中包括一份"真实标识黑名单"——
 * 黑名单本身就等于把要保护的东西写进仓库（base64 也不行），所以那份东西删掉了，
 * 只把**纯文风**规则搬进测试：不存任何真实数据，跑 `npm test` 就会检查。
 *
 * 隐私（真实账号 / 机器人 / 聊天内容）不靠自动检查，靠 review：示例一律用占位符。
 * 规则见 docs/UI_COPY.md。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "./harness.ts";

const FILES = ["public/app.js", "public/editor.js", "public/lib.js"];

/** 界面文案里不该出现的写法：[正则, 说明] */
const RULES: Array<[RegExp, string]> = [
  [/\bTG\b/, "Telegram 不缩写"],
  [/(?<!https?:\/\/\S*)\bbot\b/i, "机器人不写英文 bot"],
  [/\bself\b/, "不暴露内部取值 self（写「收藏夹」）"],
  [/0 基/, "写「从 0 开始」"],
  [/\bDO\b/, "不暴露 Durable Object 缩写（写「部署区域」）"],
  [
    /\b(apiId|apiHash|controlChat|adminUserId|triggerPrefix|pollSeconds|taskId|taskName)\b/,
    "技术字段名不该出现在文案里",
  ],
  [/[！]/, "界面文案不用感叹号"],
  [/[\u4e00-\u9fff]\(|\)[\u4e00-\u9fff]/, "中文里用全角括号"],
  [/[\u4e00-\u9fff],[ \u4e00-\u9fff]/, "中文里用全角逗号"],
];

/** 抠出含中文的字符串字面量（去掉模板串里的 `${...}` 代码片段） */
function chineseLiterals(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    for (const match of line.matchAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g)) {
      const text = match[0].slice(1, -1).replace(/\$\{[^}]*\}/g, "");
      if (/[\u4e00-\u9fff]/.test(text)) out.push({ line: index + 1, text });
    }
  });
  return out;
}

test("界面文案：符合 docs/UI_COPY.md 的词与标点规则", () => {
  const problems: string[] = [];
  for (const file of FILES) {
    const source = fs.readFileSync(file, "utf8");
    for (const literal of chineseLiterals(source)) {
      for (const [pattern, why] of RULES) {
        if (!pattern.test(literal.text)) continue;
        const snippet = literal.text.replace(/\s+/g, " ").slice(0, 50);
        problems.push(`${file}:${literal.line} ${why} → …${snippet}…`);
      }
    }
  }
  assert.equal(problems.length, 0, `文案不符合 docs/UI_COPY.md：\n${problems.join("\n")}`);
});
