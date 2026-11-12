#!/usr/bin/env node
/**
 * 发布脚本：把 `releases/unreleased.md`（就是 Release notes 本身）变成一次发布。
 *
 * 四种情况：
 *   1. 版本号 > package.json 里的版本  → 完整发版：补写 package.json、插 CHANGELOG、归档文档、打 tag
 *   2. 版本号 = 当前版本、tag 不存在   → 发布：平时已经 bump 过版本号，这里只插 CHANGELOG、归档文档、打 tag
 *   3. 版本号 = 当前版本、tag 已存在   → 只补发布：不动代码，用文档内容更新 tag / GitHub Release
 *      （给「代码已经发了、说明写晚了」这种情况兜底，重复执行也不会出错）
 *   4. 版本号 = 0.0.0（模板）或 < 当前 → 跳过 / 报错
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
import { execFileSync } from "node:child_process";

const DOC_PATH = "releases/unreleased.md";
const PACKAGE_PATH = "package.json";
const LOCK_PATH = "package-lock.json";
const CHANGELOG_PATH = "CHANGELOG.md";
const NOTES_OUT = "dist/release-notes.md";
const TEMPLATE_VERSION = "0.0.0";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");

/* ------------------------------------------------------------------ 纯函数 */

/** 解析发布文档：front matter（version/title/tag）+ 正文（就是 Release notes） */
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
  // retro: true  → 只更新这个「已存在 tag」的 GitHub Release 说明
  // retro: revoke → 撤销发版：删掉 Release 与 tag（版本号必须 ≤ 当前版本）
  const retroRaw = String(meta.retro ?? "").trim().toLowerCase();
  const retro = retroRaw === "true";
  const revoke = retroRaw === "revoke";
  // tag: false → 只更新版本号 / CHANGELOG / 归档并部署，不建 tag 与 GitHub Release
  const tagRaw = String(meta.tag ?? "").trim().toLowerCase();
  const tagEnabled = !["false", "no", "0", "off"].includes(tagRaw);
  return { version, title: String(meta.title ?? "").trim() || `v${version}`, body, retro, revoke, tagEnabled };
}

/**
 * tag 开关与发布模式必须兼容：
 * - retro / revoke 操作的是已存在的 tag；
 * - 版本号等于当前版本、tag 已存在时（只补 Release 说明）没有代码改动，只有 tag / Release 可做。
 */
export function validateTagOption({ version, current, retro, revoke, tagEnabled, tagExists = false }) {
  if ((retro || revoke) && !tagEnabled) {
    throw new Error(`retro / revoke 需要对应 tag；版本 ${version} 设置了 tag: false`);
  }
  if (version === current && tagExists && !tagEnabled) {
    throw new Error("补发布（tag 已存在）必须打 tag；跳过 tag 请把 version 改成大于当前版本");
  }
  return tagEnabled;
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
 * 发布模式：
 * - bump：文档版本大于 package.json（老流程，发布时补 bump）
 * - release：文档版本等于当前版本，且这个 tag 还没打过（平时已经 bump，发布时补 CHANGELOG / 归档）
 * - release-only：文档版本等于当前版本，tag 已存在（只补 Release 说明）
 * - error：文档版本小于当前版本
 */
export function releaseMode({ version, current, tagExists }) {
  if (version === current) return tagExists ? "release-only" : "release";
  return isNewerVersion(version, current) ? "bump" : "error";
}

/** 本地是否已有这个 tag（CI checkout fetch-depth: 0 会带上 tag） */
export function hasLocalTag(tag) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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

/** 重置后写回文档的使用说明（文档里没注释时用这份，避免重置后把说明弄丢） */
const TEMPLATE_COMMENT = `<!--
在这里写这一次发布的说明，写完后 push 到 main 就会自动发版。

规则：
1. 平时改代码只 bump package.json（和 lock），不要动这个文件；要发布时把 version 填成
   package.json 的当前版本（通常相等；只有需要临时补 bump 时才写更大的版本号）
   —— 只修 bug 用最后一位，新增用户可见能力加中间一位；和 title 一起改。
2. 分隔线 \`---\` 以下的内容就是 Release notes 正文（Markdown），会写进 CHANGELOG.md
   对应版本段和 releases/archive/vX.Y.Z.md；打 tag 时同时作为 Release 说明与 tag 注释。
3. 不是每个版本都必须打 tag：在 front matter 加 \`tag: false\`，版本号、CHANGELOG、归档与部署照常，
   跳过 tag 与 GitHub Release。retro / revoke / 只补 Release 说明仍然需要 tag。
4. 只有这个文件被改动才会触发发布；发布完成后会归档到 releases/archive/vX.Y.Z.md 并重置成模板。
5. 想补改／脱敏一个**已经打 tag** 的版本：把 version 写成那个版本号并加上 \`retro: true\`，
   工作流只会更新它的 Release 说明，不动代码、不重新打 tag。
6. 版本号保持 0.0.0（模板）不会触发任何发布。
7. 示例、日志、截图里一律用占位符（example_bot / 示例机器人 / 123456789），不要贴真实账号。
-->`;

/** 归档文件内容 + 重置后的模板（模板里的说明注释保留） */
export function buildArchiveAndTemplate({ version, title, body, template, tagEnabled = true }) {
  const archived = `---\nversion: ${version}\ntitle: ${title}\n${tagEnabled ? "" : "tag: false\n"}---\n\n${body}\n`;
  const comment = /(<!--[\s\S]*?-->)/.exec(template)?.[1] ?? TEMPLATE_COMMENT;
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
    output({ mode: "skip", skipped: "true", version: current, tag_enabled: "false" });
    return;
  }
  if (!doc.body) throw new Error("发布说明正文是空的：front matter 之后的 `---` 下面要写内容");

  // revoke：撤销发版（删 Release + tag），不动代码
  if (doc.revoke) {
    validateTagOption({ ...doc, current });
    const tag = `v${doc.version}`;
    if (doc.version === TEMPLATE_VERSION) throw new Error("revoke 也要写清要撤销哪个版本号");
    console.log(`撤销发版：${tag}（会删除 GitHub Release 与 tag，代码改动保留）`);
    if (dryRun) {
      output({ mode: "revoke", skipped: "false", version: doc.version, tag, tag_enabled: "true", title: doc.title, notes_file: NOTES_OUT });
      return;
    }
    fs.mkdirSync(path.dirname(NOTES_OUT), { recursive: true });
    fs.writeFileSync(NOTES_OUT, `${doc.title}\n\n${doc.body || "（撤销发版）"}\n`);
    const { reset } = buildArchiveAndTemplate({
      version: doc.version,
      title: doc.title,
      body: doc.body,
      template: docText,
    });
    fs.writeFileSync(DOC_PATH, reset);
    output({ mode: "revoke", skipped: "false", version: doc.version, tag, tag_enabled: "true", title: doc.title, notes_file: NOTES_OUT });
    return;
  }

  // retro：只改已发布 Release 的说明（例如修正措辞、脱敏），版本号可以 <= 当前版本
  if (doc.retro) {
    validateTagOption({ ...doc, current });
    const tag = `v${doc.version}`;
    console.log(`补改已发布 Release：${tag}（${doc.title}），不改代码`);
    if (dryRun) {
      console.log(`${doc.title}\n\n${doc.body}`);
      output({ mode: "edit-release", skipped: "false", version: doc.version, tag, tag_enabled: "true", title: doc.title, notes_file: NOTES_OUT });
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
    output({ mode: "edit-release", skipped: "false", version: doc.version, tag, tag_enabled: "true", title: doc.title, notes_file: NOTES_OUT });
    return;
  }

  const tagAlreadyExists = hasLocalTag(`v${doc.version}`);
  const mode = releaseMode({ version: doc.version, current, tagExists: tagAlreadyExists });
  if (mode === "error") {
    throw new Error(
      `版本号不能小于当前版本：文档里是 ${doc.version}，package.json 里是 ${current}（重发请改成更大的版本号，或改成当前版本号走"补发布"）`,
    );
  }
  validateTagOption({ ...doc, current, tagExists: tagAlreadyExists });
  const archiveTag = `v${doc.version}`;
  const tag = doc.tagEnabled ? archiveTag : "";
  const date = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const modeLabel = mode === "bump" ? "发版" : mode === "release" ? "发布" : "补发布";
  const versionLabel = mode === "bump" ? `${current} → ${doc.version}` : doc.version;
  console.log(`${modeLabel}：${versionLabel}（${doc.title}）`);
  if ((mode === "bump" || mode === "release") && !doc.tagEnabled) console.log("本版不打 tag，也不创建 GitHub Release");

  if (dryRun) {
    if (mode === "bump" || mode === "release") {
      console.log("--- 将插入 CHANGELOG 的内容 ---");
      console.log(buildChangelogEntry({ version: doc.version, body: doc.body, date }));
    } else {
      console.log("--- 不改代码，只用文档内容建 tag / Release ---");
    }
    console.log(doc.tagEnabled ? "--- Release notes（tag 注释同此）---" : "--- 发布说明（只写入 CHANGELOG / 归档）---");
    console.log(`${doc.title}\n\n${doc.body}`);
    output({
      mode,
      skipped: "false",
      version: doc.version,
      tag,
      tag_enabled: String(doc.tagEnabled),
      title: doc.title,
      notes_file: NOTES_OUT,
    });
    return;
  }

  // 三种模式都要产出 Release notes 文件
  fs.mkdirSync(path.dirname(NOTES_OUT), { recursive: true });
  fs.writeFileSync(NOTES_OUT, `${doc.title}\n\n${doc.body}\n`);

  if (mode === "bump" || mode === "release") {
    const changelog = fs.readFileSync(CHANGELOG_PATH, "utf8");
    const entry = buildChangelogEntry({ version: doc.version, body: doc.body, date });
    const applied = applyChangelog(changelog, entry);
    fs.writeFileSync(CHANGELOG_PATH, applied.changelog);
    if (applied.leftover) {
      console.log("提示：[Unreleased] 里原有内容已清空（确认这些细节都进了发布说明）：");
      console.log(applied.leftover.split("\n").slice(0, 20).join("\n"));
    }

    if (mode === "bump") {
      pkg.version = doc.version;
      fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
      if (fs.existsSync(LOCK_PATH)) {
        const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
        fs.writeFileSync(LOCK_PATH, `${JSON.stringify(syncLock(lock, doc.version), null, 2)}\n`);
      }
    }

    const { archived, reset } = buildArchiveAndTemplate({
      version: doc.version,
      title: doc.title,
      body: doc.body,
      template: docText,
      tagEnabled: doc.tagEnabled,
    });
    fs.writeFileSync(path.join("releases", "archive", `${archiveTag}.md`), archived);
    fs.writeFileSync(DOC_PATH, reset);
    console.log(
      `已更新 ${mode === "bump" ? "package.json / package-lock.json / " : ""}CHANGELOG.md，` +
        `归档到 releases/archive/${archiveTag}.md` +
        (doc.tagEnabled ? "" : "（本版不打 tag）"),
    );
  } else {
    console.log(`版本号与当前一致（${current}）且 tag 已存在：只补 tag / Release，不改代码`);
  }

  output({
    mode,
    skipped: "false",
    version: doc.version,
    tag,
    tag_enabled: String(doc.tagEnabled),
    title: doc.title,
    notes_file: NOTES_OUT,
  });
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
