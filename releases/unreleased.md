---
version: 0.0.0
title: v0.0.0 — 未命名发布
---

<!--
在这里写这一次发布的说明，写完后 push 到 main 就会自动发版。

规则：
1. 把上面 front matter 里的 version 改成新的版本号（必须严格大于 package.json 里的当前版本）
   —— 只修 bug 用最后一位，新增用户可见能力加中间一位；和 title 一起改。
2. 分隔线 `---` 以下的内容就是 Release notes 正文（Markdown），会同时写进 CHANGELOG.md
   对应版本段、GitHub Release 说明、以及 annotated tag 的注释。
3. 只有这个文件被改动才会触发发布；发布完成后会归档到 releases/archive/vX.Y.Z.md 并重置成模板。
4. 想补改／脱敏一个**已经发布**的版本：把 version 写成那个版本号并加上 `retro: true`，
   工作流只会更新它的 Release 说明，不动代码、不重新打 tag。
5. 版本号保持 0.0.0（模板）不会触发任何发布。
6. 示例、日志、截图里一律用占位符（example_bot / 示例机器人 / 123456789），不要贴真实账号。
-->
