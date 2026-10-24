/** 发布文档解析 + CHANGELOG 插入（发版脚本的核心逻辑） */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import {
  buildArchiveAndTemplate,
  buildChangelogEntry,
  insertChangelogEntry,
  isNewerVersion,
  parseReleaseDoc,
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

test("insertChangelogEntry：插到 Unreleased 之后、旧版本之前", () => {
  const changelog = "# 更新日志\n\n## [Unreleased]\n\n## [0.17.1] - 2026-10-24\n\n- 旧内容\n";
  const entry = buildChangelogEntry({ version: "0.18.0", body: "- 新内容", date: "2026-10-25" });
  const next = insertChangelogEntry(changelog, entry);
  assert.match(next, /## \[Unreleased\]\n\n## \[0\.18\.0\] - 2026-10-25\n\n- 新内容/);
  assert.match(next, /## \[0\.17\.1\] - 2026-10-24/);
  assert.ok(next.indexOf("0.18.0") < next.indexOf("0.17.1"), "新版本要在旧版本前面");
  assert.throws(() => insertChangelogEntry("# 没有 unreleased", entry), /找不到/);
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
