/** 版本检查：仓库名收敛与 package.json / Release 两个来源的合并 */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { cleanVersion, mergeUpdateSources, repoOf } from "../src/update.ts";

test("repoOf：只接受 owner/repo，非法值回退默认仓库", () => {
  assert.equal(repoOf("mihucho/cf-tg-checkin"), "mihucho/cf-tg-checkin");
  assert.equal(repoOf("  mihucho/cf-tg-checkin  "), "mihucho/cf-tg-checkin");
  assert.equal(repoOf(""), "mihucho/cf-tg-checkin");
  assert.equal(repoOf(undefined), "mihucho/cf-tg-checkin");
  assert.equal(repoOf("not-a-repo"), "mihucho/cf-tg-checkin");
  assert.equal(repoOf("a/b/c"), "mihucho/cf-tg-checkin");
  assert.equal(repoOf("https://github.com/a/b"), "mihucho/cf-tg-checkin");
});

test("cleanVersion：去掉 v 前缀，非法版本返回 null", () => {
  assert.equal(cleanVersion("v0.20.3"), "0.20.3");
  assert.equal(cleanVersion("0.20.3"), "0.20.3");
  assert.equal(cleanVersion("0.20.3-beta.1"), "0.20.3-beta.1");
  assert.equal(cleanVersion("  "), null);
  assert.equal(cleanVersion("最新版"), null);
});

test("mergeUpdateSources：package.json 覆盖未打 tag 的版本", () => {
  const info = mergeUpdateSources({ repo: "a/b", current: "0.20.2", packageVersion: "0.20.3" });
  assert.deepEqual(info, {
    current: "0.20.2",
    latest: "0.20.3",
    hasUpdate: true,
    url: "https://github.com/a/b/blob/main/CHANGELOG.md",
  });
});

test("mergeUpdateSources：Release 更新时取 Release 版本与链接", () => {
  const info = mergeUpdateSources({
    repo: "a/b",
    current: "0.20.2",
    packageVersion: "0.20.3",
    releaseTag: "v0.20.4",
    releaseUrl: "https://github.com/a/b/releases/tag/v0.20.4",
  });
  assert.equal(info.latest, "0.20.4");
  assert.equal(info.hasUpdate, true);
  assert.equal(info.url, "https://github.com/a/b/releases/tag/v0.20.4");
});

test("mergeUpdateSources：Release 不比 package.json 新时保留 package.json 与 CHANGELOG 链接", () => {
  const info = mergeUpdateSources({
    repo: "a/b",
    current: "0.20.2",
    packageVersion: "0.20.4",
    releaseTag: "v0.20.3",
    releaseUrl: "https://github.com/a/b/releases/tag/v0.20.3",
  });
  assert.equal(info.latest, "0.20.4");
  assert.equal(info.url, "https://github.com/a/b/blob/main/CHANGELOG.md");
});

test("mergeUpdateSources：版本相同时用 Release 链接", () => {
  const info = mergeUpdateSources({
    repo: "a/b",
    current: "0.20.2",
    packageVersion: "0.20.3",
    releaseTag: "v0.20.3",
    releaseUrl: "https://github.com/a/b/releases/tag/v0.20.3",
  });
  assert.equal(info.latest, "0.20.3");
  assert.equal(info.url, "https://github.com/a/b/releases/tag/v0.20.3");
});

test("mergeUpdateSources：当前已是最新 / 没有数据时不误报", () => {
  const upToDate = mergeUpdateSources({ repo: "a/b", current: "0.20.3", packageVersion: "0.20.3" });
  assert.equal(upToDate.hasUpdate, false);

  const empty = mergeUpdateSources({ repo: "a/b", current: "0.20.3" });
  assert.deepEqual(empty, { current: "0.20.3", latest: null, hasUpdate: false, url: null });

  const invalid = mergeUpdateSources({
    repo: "a/b",
    current: "0.20.3",
    packageVersion: "垃圾",
    releaseTag: "nightly",
  });
  assert.deepEqual(invalid, { current: "0.20.3", latest: null, hasUpdate: false, url: null });
});

test("mergeUpdateSources：只信任 GitHub 的 Release 链接", () => {
  const info = mergeUpdateSources({
    repo: "a/b",
    current: "0.20.2",
    releaseTag: "v0.20.3",
    releaseUrl: "javascript:alert(1)",
  });
  assert.equal(info.url, null);
  assert.equal(info.hasUpdate, true);
});
