/** 版本号比较（新版本提示用） */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { isNewerVersion, parseVersion } from "../src/util/version.ts";

test("parseVersion：容忍 v 前缀与后缀", () => {
  assert.deepEqual(parseVersion("v0.19.2"), [0, 19, 2]);
  assert.deepEqual(parseVersion("0.19.2"), [0, 19, 2]);
  assert.deepEqual(parseVersion("1.2.3-beta.1"), [1, 2, 3]);
  assert.deepEqual(parseVersion("垃圾"), [0, 0, 0]);
  assert.deepEqual(parseVersion(""), [0, 0, 0]);
});

test("isNewerVersion：逐段比较", () => {
  assert.equal(isNewerVersion("v0.19.3", "0.19.2"), true);
  assert.equal(isNewerVersion("v0.20.0", "0.19.9"), true);
  assert.equal(isNewerVersion("v1.0.0", "0.99.99"), true);
  assert.equal(isNewerVersion("v0.19.2", "0.19.2"), false);
  assert.equal(isNewerVersion("v0.19.1", "0.19.2"), false);
  // 认不出的一律当 0.0.0，不会误报有新版本
  assert.equal(isNewerVersion("不是版本号", "0.19.2"), false);
});
