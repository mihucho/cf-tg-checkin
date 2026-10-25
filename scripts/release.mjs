#!/usr/bin/env node
/**
 * 发布脚本：把 `releases/unreleased.md`（就是 Release notes 本身）变成一次发布。
 *
 * 三种情况：
 *   1. 版本号 > package.json 里的版本  → 完整发版：写 package.json、插 CHANGELOG、归档文档、打 tag
 *   2. 版本号 = 当前版本               → 只补发布：不动代码，用文档内容建 tag / GitHub Release
 *      （给「代码已经发了、说明写晚了」这种情况兜底，重复执行也不会出错）
 *   3. 版本号 = 0.0.0（模板）或 < 当前 → 跳过 / 报错
 *
 * git / gh 操作留在 workflow 里；这里只做确定性的文件改动，并输出 mode/tag/title 等结果。
 *
 * 用法：
 *   node scripts/release.mjs --dry-run   # 只打印将要做的事
 *   node scripts/release.mjs             # 真的改文件（workflow 用）
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DOC_PATH = "releases/unreleased.md";
const PACKAGE_PATH = "package.json";
const LOCK_PATH = "package-lock.json";
const CHANGELOG_PATH = "CHANGELOG.md";
const NOTES_OUT = "dist/release-notes.md";
const TEMPLATE_VERSION = "0.0.0";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");

/* ------------------------------------------------------------------ 纯函数 */

/** 解析发布文档：front matter（version/title）+ 正文（就是 Release notes） */
export function parseReleaseDoc(raw) {
  const text = String(raw ?? "").replace(/\r\n/g, "\n").trimStart();
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error("发布文档缺少 front matter：开头要有 `---` / `version: x.y.z` / `---`");

  const meta = {};
  for (const line of match[1].split("\n")) {
    const item = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!item) continue;
    meta[item[1]] = item[2].replace(/^["']|["']$/g, "").trim();
  }

  const body = match[2]
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const version = String(meta.version ?? "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`front matter 的 version 必须是 x.y.z（当前是「${version || "(空)"}」）`);
  }
  // retro: true → 只更新这个「已存在 tag」的 GitHub Release 说明，不改代码、不建 tag
  const retro = String(meta.retro ?? "").trim().toLowerCase() === "true";
  return { version, title: String(meta.title ?? "").trim() || `v${version}`, body, retro };
}

/** a 是否严格大于 b（只比 x.y.z） */
export function isNewerVersion(a, b) {
  const parse = (value) => String(value).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch > bPatch;
}

/**
 * 把新版本段插到 `## [Unreleased]` 之后，并清空 Unreleased 区。
 *
 * 返回被清掉的内容（leftover）——workflow 会打印出来，
 * 这样"忘了把 [Unreleased] 里的细节搬进发布说明"这件事能被看见。
 */
export function applyChangelog(changelog, entry) {
  const text = String(changelog ?? "");
  const heading = "## [Unreleased]";
  const index = text.indexOf(heading);
  if (index < 0) throw new Error("CHANGELOG.md 里找不到 `## [Unreleased]`，无法插入新版本段");

  const afterHeading = index + heading.length;
  const rest = text.slice(afterHeading);
  const next = rest.search(/\n## \[/);
  const beforeNext = next >= 0 ? rest.slice(0, next) : rest;
  const tail = next >= 0 ? rest.slice(next).replace(/^\n+/, "") : "";

  const leftover = beforeNext.trim();
  const head = `${text.slice(0, afterHeading)}\n\n${String(entry).trim()}\n\n`;
  return { changelog: tail ? `${head}${tail}` : head, leftover };
}

/** 只要结果、不要 leftover 时的简写 */
export function insertChangelogEntry(changelog, entry) {
  return applyChangelog(changelog, entry).changelog;
}

export function buildChangelogEntry({ version, body, date }) {
  return [`## [${version}] - ${date}`, "", body ? body.trim() : "- （没有写发布说明）", ""].join("\n");
}

/** 归档文件内容 + 重置后的模板（模板里的说明注释保留） */
export function buildArchiveAndTemplate({ version, title, body, template }) {
  const archived = `---\nversion: ${version}\ntitle: ${title}\n---\n\n${body}\n`;
  const comment = /(<!--[\s\S]*?-->)/.exec(template)?.[1] ?? "";
  const reset = `---\nversion: ${TEMPLATE_VERSION}\ntitle: v0.0.0 — 未命名发布\n---\n\n${comment}\n`;
  return { archived, reset };
}

/* ------------------------------------------------------------------ 主流程 */

function output(pairs) {
  const lines = Object.entries(pairs)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value).replace(/\n/g, " ")}`)
    .join("\n");
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${lines}\n`);
  console.log(lines);
}

function syncLock(lock, version) {
  if (!lock) return lock;
  lock.version = version;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
  return lock;
}

function main() {
  if (!fs.existsSync(DOC_PATH)) throw new Error(`找不到 ${DOC_PATH}`);
  const docText = fs.readFileSync(DOC_PATH, "utf8");
  const doc = parseReleaseDoc(docText);
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const current = String(pkg.version ?? "0.0.0");

  if (doc.version === TEMPLATE_VERSION) {
    console.log(`发布文档还是模板（version ${TEMPLATE_VERSION}），跳过`);
    output({ mode: "skip", skipped: "true", version: current, tag: `v${current}` });
    return;
  }
  if (!doc.body) throw new Error("发布说明正文是空的：front matter 之后的 `---` 下面要写内容");

  // retro：只改已发布 Release 的说明（例如修正措辞、脱敏），版本号可以 <= 当前版本
  if (doc.retro) {
    const tag = `v${doc.version}`;
    console.log(`补改已发布 Release：${tag}（${doc.title}），不改代码`);
    if (dryRun) {
      console.log(`${doc.title}\n\n${doc.body}`);
      output({ mode: "edit-release", skipped: "false", version: doc.version, tag, title: doc.title, notes_file: NOTES_OUT });
      return;
    }
    fs.mkdirSync(path.dirname(NOTES_OUT), { recursive: true });
    fs.writeFileSync(NOTES_OUT, `${doc.title}\n\n${doc.body}\n`);
    const { reset } = buildArchiveAndTemplate({
      version: doc.version,
      title: doc.title,
      body: doc.body,
      template: docText,
    });
    fs.writeFileSync(DOC_PATH, reset);
    output({ mode: "edit-release", skipped: "false", version: doc.version, tag, title: doc.title, notes_file: NOTES_OUT });
    return;
  }

  if (!isNewerVersion(doc.version, current) && doc.version !== current) {
    throw new Error(
      `版本号不能小于当前版本：文档里是 ${doc.version}，package.json 里是 ${current}（重发请改成更大的版本号，或改成当前版本号走"只补发布"）`,
    );
  }

  const mode = doc.version === current ? "release-only" : "bump";
  const tag = `v${doc.version}`;
  const date = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  console.log(`${mode === "bump" ? "发版" : "只补发布"}：${current} → ${doc.version}（${doc.title}）`);

  if (dryRun) {
    if (mode === "bump") {
      console.log("--- 将插入 CHANGELOG 的内容 ---");
      console.log(buildChangelogEntry({ version: doc.version, body: doc.body, date }));
    } else {
      console.log("--- 不改代码，只用文档内容建 tag / Release ---");
    }
    console.log("--- Release notes（tag 注释同此）---");
    console.log(`${doc.title}\n\n${doc.body}`);
    output({ mode, skipped: "false", version: doc.version, tag, title: doc.title, notes_file: NOTES_OUT });
    return;
  }

  // 两种模式都要产出 Release notes 文件
  fs.mkdirSync(path.dirname(NOTES_OUT), { recursive: true });
  fs.writeFileSync(NOTES_OUT, `${doc.title}\n\n${doc.body}\n`);

  if (mode === "bump") {
    const changelog = fs.readFileSync(CHANGELOG_PATH, "utf8");
    const entry = buildChangelogEntry({ version: doc.version, body: doc.body, date });
    const applied = applyChangelog(changelog, entry);
    fs.writeFileSync(CHANGELOG_PATH, applied.changelog);
    if (applied.leftover) {
      console.log("提示：[Unreleased] 里原有内容已清空（确认这些细节都进了发布说明）：");
      console.log(applied.leftover.split("\n").slice(0, 20).join("\n"));
    }

    pkg.version = doc.version;
    fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
    if (fs.existsSync(LOCK_PATH)) {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
      fs.writeFileSync(LOCK_PATH, `${JSON.stringify(syncLock(lock, doc.version), null, 2)}\n`);
    }

    const { archived, reset } = buildArchiveAndTemplate({
      version: doc.version,
      title: doc.title,
      body: doc.body,
      template: docText,
    });
    fs.writeFileSync(path.join("releases", "archive", `${tag}.md`), archived);
    fs.writeFileSync(DOC_PATH, reset);
    console.log(`已更新 package.json / package-lock.json / CHANGELOG.md，归档到 releases/archive/${tag}.md`);
  } else {
    console.log(`版本号与当前一致（${current}）：只补 tag / Release，不改代码`);
  }

  output({ mode, skipped: "false", version: doc.version, tag, title: doc.title, notes_file: NOTES_OUT });
}

// 直接 `node scripts/release.mjs` 时才执行；被测试 import 时不要跑
const invokedDirectly = Boolean(process.argv[1] && process.argv[1].endsWith("release.mjs"));
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    output({ mode: "error", skipped: "true", error: String(error.message).slice(0, 200) });
    process.exit(1);
  }
}
