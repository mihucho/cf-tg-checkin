---
version: 0.0.0
title: v0.0.0 — 未命名发布
---

<!--
在这里写这一次发布的说明，写完后 push 到 main 就会自动发版。

规则：
1. 平时改代码只 bump package.json（和 lock），不要动这个文件；要发布时把 version 填成
   package.json 的当前版本（通常相等；只有需要临时补 bump 时才写更大的版本号）
   —— 只修 bug 用最后一位，新增用户可见能力加中间一位；和 title 一起改。
2. 分隔线 `---` 以下的内容就是 Release notes 正文（Markdown），会写进 CHANGELOG.md
   对应版本段和 releases/archive/vX.Y.Z.md；打 tag 时同时作为 Release 说明与 tag 注释。
3. 不是每个版本都必须打 tag：在 front matter 加 `tag: false`，版本号、CHANGELOG、归档与部署照常，
   跳过 tag 与 GitHub Release。retro / revoke / 只补 Release 说明仍然需要 tag。
4. 只有这个文件被改动才会触发发布；发布完成后会归档到 releases/archive/vX.Y.Z.md 并重置成模板。
5. 想补改／脱敏一个**已经打 tag** 的版本：把 version 写成那个版本号并加上 `retro: true`，
   工作流只会更新它的 Release 说明，不动代码、不重新打 tag。
6. 版本号保持 0.0.0（模板）不会触发任何发布。
7. 示例、日志、截图里一律用占位符（example_bot / 示例机器人 / 123456789），不要贴真实账号。
-->
