/** 发布文档解析 + CHANGELOG 插入（发版脚本的核心逻辑） */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import {
  applyChangelog,
  buildArchiveAndTemplate,
  buildChangelogEntry,
  insertChangelogEntry,
  isNewerVersion,
  parseReleaseDoc,
  releaseMode,
  validateTagOption,
} from "../scripts/release.mjs";

const doc = (version: string, title: string, body: string) =>
  `---\nversion: ${version}\ntitle: ${title}\n---\n\n${body}\n`;

test("parseReleaseDoc：front matter + 正文，注释被剔除", () => {
  const parsed = parseReleaseDoc(doc("0.18.0", "v0.18.0 — 测试", "正文第一行\n\n<!-- 说明 -->\n正文第二行"));
  assert.equal(parsed.version, "0.18.0");
  assert.equal(parsed.title, "v0.18.0 — 测试");
  assert.equal(parsed.body, "正文第一行\n\n正文第二行");
});

test("parseReleaseDoc：缺 front matter / 版本号非法都要明确报错", () => {
  assert.throws(() => parseReleaseDoc("没有 front matter"), /缺少 front matter/);
  assert.throws(() => parseReleaseDoc(doc("1.0", "t", "b")), /必须是 x\.y\.z/);
  // 标题缺省时用 v{version}
  assert.equal(parseReleaseDoc("---\nversion: 1.2.3\n---\n\n正文").title, "v1.2.3");
});

test("isNewerVersion：只比 x.y.z", () => {
  assert.equal(isNewerVersion("0.18.0", "0.17.1"), true);
  assert.equal(isNewerVersion("0.17.2", "0.17.1"), true);
  assert.equal(isNewerVersion("1.0.0", "0.99.99"), true);
  assert.equal(isNewerVersion("0.17.1", "0.17.1"), false);
  assert.equal(isNewerVersion("0.17.0", "0.17.1"), false);
});

test("releaseMode：大于当前版本补 bump；等于且没 tag 走完整发布；等于且已有 tag 只补说明", () => {
  assert.equal(releaseMode({ version: "0.20.6", current: "0.20.5", tagExists: false }), "bump");
  assert.equal(releaseMode({ version: "0.20.5", current: "0.20.5", tagExists: false }), "release");
  assert.equal(releaseMode({ version: "0.20.5", current: "0.20.5", tagExists: true }), "release-only");
  assert.equal(releaseMode({ version: "0.20.4", current: "0.20.5", tagExists: true }), "error");
});

test("insertChangelogEntry：插到 Unreleased 之后、旧版本之前", () => {
  const changelog = "# 更新日志\n\n## [Unreleased]\n\n## [0.17.1] - 2026-10-24\n\n- 旧内容\n";
  const entry = buildChangelogEntry({ version: "0.18.0", body: "- 新内容", date: "2026-10-25" });
  const next = insertChangelogEntry(changelog, entry);
  assert.match(next, /## \[Unreleased\]\n\n## \[0\.18\.0\] - 2026-10-25\n\n- 新内容/);
  assert.match(next, /## \[0\.17\.1\] - 2026-10-24/);
  assert.ok(next.indexOf("0.18.0") < next.indexOf("0.17.1"), "新版本要在旧版本前面");
  assert.throws(() => insertChangelogEntry("# 没有 unreleased", entry), /找不到/);
});

test("applyChangelog：插新版本的同时清空 Unreleased，并回报被清掉的内容", () => {
  const changelog = "# 更新日志\n\n## [Unreleased]\n\n- 还没发的小改动\n- 再去一条\n\n## [0.17.1] - 2026-10-24\n\n- 旧内容\n";
  const entry = buildChangelogEntry({ version: "0.18.0", body: "- 新内容", date: "2026-10-25" });
  const { changelog: next, leftover } = applyChangelog(changelog, entry);
  assert.match(leftover, /还没发的小改动/);
  assert.match(next, /## \[Unreleased\]\n\n## \[0\.18\.0\] - 2026-10-25/);
  assert.doesNotMatch(next.slice(next.indexOf("## [Unreleased]"), next.indexOf("## [0.18.0]")), /还没发的小改动/);
  assert.match(next, /## \[0\.17\.1\] - 2026-10-24/);
});

test("buildArchiveAndTemplate：归档保留标题，模板回落到 0.0.0 并保留说明注释", () => {
  const template = doc("0.0.0", "v0.0.0 — 未命名发布", "<!-- 这里是说明 -->");
  const { archived, reset } = buildArchiveAndTemplate({
    version: "0.18.0",
    title: "v0.18.0 — 测试",
    body: "正文",
    template,
  });
  assert.match(archived, /^---\nversion: 0\.18\.0\ntitle: v0\.18\.0 — 测试\n---\n\n正文/);
  assert.match(reset, /version: 0\.0\.0/);
  assert.match(reset, /<!-- 这里是说明 -->/, "模板里的使用说明要保留");
});

test("parseReleaseDoc：tag 开关，默认打 tag", () => {
  assert.equal(parseReleaseDoc(doc("0.20.0", "t", "b")).tagEnabled, true);
  assert.equal(parseReleaseDoc(doc("0.20.0", "t", "b").replace("title:", "tag: false\ntitle:")).tagEnabled, false);
  assert.equal(parseReleaseDoc(doc("0.20.0", "t", "b").replace("title:", "tag: true\ntitle:")).tagEnabled, true);
});

test("validateTagOption：tag 开关与发布模式兼容", () => {
  assert.equal(validateTagOption({ version: "0.20.0", current: "0.19.2", tagEnabled: false }), false);
  assert.equal(validateTagOption({ version: "0.20.0", current: "0.20.0", tagEnabled: false }), false);
  assert.throws(
    () => validateTagOption({ version: "0.20.0", current: "0.19.2", retro: true, tagEnabled: false }),
    /retro \/ revoke/,
  );
  assert.throws(
    () => validateTagOption({ version: "0.20.0", current: "0.19.2", revoke: true, tagEnabled: false }),
    /retro \/ revoke/,
  );
  assert.throws(
    () => validateTagOption({ version: "0.19.2", current: "0.19.2", tagEnabled: false, tagExists: true }),
    /补发布/,
  );
});

test("buildArchiveAndTemplate：不打 tag 的版本在归档里保留标记", () => {
  const { archived } = buildArchiveAndTemplate({
    version: "0.20.0",
    title: "v0.20.0 — 测试",
    body: "正文",
    template: doc("0.0.0", "t", ""),
    tagEnabled: false,
  });
  assert.match(archived, /^---\nversion: 0\.20\.0\ntitle: v0\.20\.0 — 测试\ntag: false\n---\n\n正文/);
});
