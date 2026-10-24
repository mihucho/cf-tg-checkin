# AGENTS.md

给在这个仓库里动手的 agent（以及未来的自己）。**先读这一页，再读你要改的文件头注释** ——
`src/` 下每个文件开头都写了「为什么这么写 / 为什么不能用更简单的做法」，很多约束的原因在那里。

---

## 一句话

Telegram 自动签到系统，全部跑在 Cloudflare Workers + **单个** Durable Object 上：
MTProto 走 `cloudflare:sockets`（`src/telegram/`），调度靠 DO alarm，数据全在 DO 内嵌 SQLite
（`src/db.ts`），管理界面是 `public/` 里的纯静态原生 JS/CSS。没有 VPS、没有常驻进程。

- 运行时依赖只有 `teleproto` 一个。**不要随手加依赖**（Workers 体积、`eval` 限制、node 内建兼容都要自己扛）。
- 前端没有构建步骤，`public/` 由 Workers Assets 直出；`/api/*` 先过 Worker（见 `wrangler.jsonc` 的 `run_worker_first`）。
- 文档、代码注释、界面文案、提交信息**一律中文**。提交信息格式：`type(scope): 中文描述（版本号）`。

---

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit`（覆盖 `src/**` + `build.mjs`，`strict: true`） |
| `npm test` | `build.mjs --test` 打包 `tests/index.test.ts` → 在 Node 里跑（当前 140 例，几秒） |
| `npm run check` | typecheck → test → build → 检查产物导出（提 PR 前跑这个） |
| `npm run dev` | `wrangler dev`（`build.command` 会先跑一遍 esbuild） |
| `npm run test:integration` | 真起 `wrangler dev`（随机端口 + 临时目录），HTTP 打通 Worker→DO→SQLite，48 项；约 45 秒，带 180 秒看门狗 |
| `npm run smoke` | 用 `wrangler.smoke.jsonc` 起一个不连 Telegram 的最小 Worker（排查部署问题用） |
| `npm run deploy` | build → `check-bundle` → `wrangler deploy` |
| `node scripts/release.mjs --dry-run` | 预览「改发布文档」会做哪些改动（不落盘） |
| `node build.mjs --watch` | 只跑打包 watch |

## 版本号约定

**修 bug 永远只动最后一位（`patch`）。** 判断口径只有一条：

> 这条改动要不要写进 README / 让用户重新学怎么用？要 → `minor`；不要 → `patch`。

| 类型 | 什么时候用 | 例 |
| --- | --- | --- |
| `patch` | 修 bug、把错的行为改对、文案/样式微调、内部重构、测试、依赖升级（对外行为不变） | 0.12.1「点图标不再弹详情」 |
| `minor` | 新增用户可见能力：新功能、新 API/字段、新触发语法、新界面模块，或交互方式/信息架构变化 | 0.8.0「导入导出」、0.10.2「全局改弹窗」 |
| `major` | 不兼容变更：删 API/字段、改数据语义、配置或部署方式不兼容、需手动迁移 | — |

- 还在 `0.x` 时，不兼容变更允许只 bump `minor`（semver 如此），但 CHANGELOG 该版本第一行必须写 **`BREAKING`** 并说明怎么迁移。
- 同一天多个修复合并进**一个** `patch`；不跳号、不回改已发布版本。
- 平时改动写进 `CHANGELOG.md` 的 `[Unreleased]`（开发向，可以很细）；发版时把**面向使用者**的部分整理进
  `releases/unreleased.md`，脚本插入新版本段时会自动清空 `[Unreleased]`，并把清掉的内容打印在 Actions 日志里
  —— 看到那段提示就确认一下细节没漏进发布说明。
- `1.0.0` 只留给「接口 / 数据 / 部署方式稳定、愿意承诺兼容」的那天，不是攒够功能就发。
- 拿不准先按 `patch`；等真的需要用户「知道」时再 `minor`。
- （历史遗留：0.11.0 是纯修复却发了 `minor`，属早期误判，不回改；新版本按上表走。）

版本号**只有一个来源：`package.json`**。别手改 `src/version.ts` —— `build.mjs` 会把 version / git commit /
构建时间注入产物，`GET /api/version` 和页面底部可查。

但**发版不要手跑 `npm version`**：版本号由发布文档驱动（见下一节），`npm version` 会绕过 CHANGELOG 插入与归档。

---

## 发版（改文档即发布）

发布说明本身就是 `releases/unreleased.md`，push 到 `main` 后由 `.github/workflows/release.yml` 自动执行：

```markdown
---
version: 0.18.0
title: v0.18.0 — 一句话标题
---

正文就是 GitHub Release 的说明（Markdown），同时作为 annotated tag 的注释。
```

| 文档里的 `version` | 行为 |
| --- | --- |
| **大于** `package.json` | 跑 typecheck + 单测 + 打包自检 → 写 `package.json`/`package-lock.json` → 把正文插进 `CHANGELOG.md`（`[Unreleased]` 之后）→ 归档到 `releases/archive/vX.Y.Z.md` 并重置模板 → 提交 → 打 annotated tag → 建/更新 GitHub Release → 触发 `deploy.yml` |
| **等于**当前版本 | 只补 tag / GitHub Release（代码已发、说明写晚了；重复执行安全） |
| **`0.0.0`**（模板） | 跳过 |

规矩：

- **只有 `releases/unreleased.md` 的变化会触发发布**，别的改动走普通 CI；不要在别处手动 bump 版本号
- 版本号判断口径见上一节（修 bug = `patch`），文档里写错会被脚本拒掉（必须严格递增，非 `x.y.z` 直接报错）
- 正文要有内容（只写 front matter 会报错）；写完先 `node scripts/release.mjs --dry-run` 预览
- 发完别手动改 `releases/unreleased.md` 的历史内容 —— 归档副本在 `releases/archive/`
- `GITHUB_TOKEN` push 出去的 commit **不会**触发其它工作流，所以 workflow 里显式 `gh workflow run deploy.yml`；
  想让它像普通 push 一样级联，在仓库 Secrets 配 `RELEASE_TOKEN`（带 `repo` 的 PAT）
- 历史遗留：v0.17.1 及之前的版本是手工 `git tag` 打的，没有 release 文档；从下一个版本起走上面这套

---

## 硬约束（都是踩过的坑，别改回去）

### 构建 / 运行时

1. **不能用 wrangler 自带打包。** `build.mjs` 做三件 wrangler 做不到的事：
   - `node:net` / `fs` / `path` / `socks` / `node-localstorage` 换成 `src/shims/*` 的桩；
   - 其余 node 内建重定向到虚拟模块，变成顶层静态 `import`，否则运行时报
     `Dynamic require of node:xxx is not supported`；
   - 给 teleproto 的 `tl/runtime/fieldCodec.js` 追加 `build/patches/fieldCodec.js`，因为
     **workerd 禁止 `eval` / `new Function`**，而 teleproto 用它们生成 TL 字段读写器。
   新增 node 内建依赖时，先看 workerd 是否有 `nodejs_compat` 支持，否则在 `build.mjs` 的 `stubs` 里加桩。
2. `dist/` 是生成物（已 gitignore），**不要手改、不要提交**。
3. 打包产物必须导出 `TgAgent`，否则线上报
   `does not export class 'TgAgent' which is depended on by existing Durable Objects`。
   `npm run deploy` / CI 都会跑 `scripts/check-bundle.mjs` 兜这一层。

### DO / 存储

4. **跨请求状态一律落 DO SQLite**（`Store`）。DO 随时会被驱逐，模块级变量只在单次请求内有效；
   唯一例外是**可重建**的缓存（如 30 秒的连接复用、7 天趋势的 60 秒缓存）。
5. DO 里所有执行走 `this.serialize()` 串行队列（`alarm()`、`/tasks/:id/run`、`run-all` 都包在里面），
   别绕过它并发跑 Telegram 操作。
6. schema 改动：`CREATE TABLE IF NOT EXISTS ...` + 在 `Store` 初始化里**追加**用 `try/catch` 包住的
   `ALTER TABLE ... ADD COLUMN`（写法见 `src/db.ts` 里已有的几条）。绝不要建新表替代老表。
   任务删除时要一并清理关联 kv（`task:<id>:sent:<target>`、`notify:<id>:at`）。
7. `logs` 只保留最近 2000 条（`Store` 里插入后裁剪），别加无上限的表。

### 网络 / 协议

8. **不要指望长连接。** 连接只做 30 秒内的复用（`CLIENT_IDLE_REUSE_MS`），空闲主动断开；
   每次操作靠 session 里的 auth key 重连（1 RTT）。默认假设随时被驱逐。
9. **不依赖 Telegram updates 推送**：点按钮前轮询机器人回复；触发配置靠轮询控制会话。
10. 只对**连接错误**重试（`isConnectionError()`）。业务错误重连重跑会把「已经发出去的消息」再发一遍。
11. 每次执行都有时间预算（`taskBudgetMs()`，30 秒 ~ 4 分钟），超出就停止后续步骤并**如实记录**
    「超出时间预算，未跑完所有步骤」，不要跑满到被驱逐。
12. 触发器轮询按批回溯（100 条 × 最多 5 批，按 id 去重），不要改回「只取最近 N 条」—— 会丢指令。

### 安全

13. 所有 `/api` 响应必须带 `cache-control: no-store`（浏览器会对无缓存头的 GET 做启发式缓存，
    前端会一直显示旧数据）。
14. Turnstile secret 永不回传前端：输出走 `redactSettings()`，只给 `turnstileSecretConfigured: boolean`；
    `/auth/turnstile` 要求 `x-internal-call` 头（Worker 代理会重建请求头，外部注入不了）。
15. 错误对外只给 `publicError()`（SQLite/约束类错误统一转成「请求参数不合法」），别把驱动错误文本漏出去。
16. 静态资源 CSP 在 `public/_headers`，`script-src 'self'`（外加 Turnstile 域）。引入外部资源前先改 CSP，
    并确认 `wrangler.jsonc` 只用**整行** `//` 注释（`scripts/check-bundle.mjs` 是整行剥离后 `JSON.parse` 的）。
17. 登录 Cookie 是无状态 HMAC token（7 天），登出只清浏览器 Cookie；改密码/`SESSION_SECRET` 才能全端失效。

### 数据不变量

18. **`task.targets[0]` 永远等于 `task.target`**，只有主目标能写 `target` 和改任务名 ——
    统一走纯函数 `applyTargetPatch(task, index, patch)`，别再手写 `updateTask({ target })`（v0.10.1 的 P0）。
19. 去重指纹 `taskFingerprint` 必须包含 `targets`，否则「主目标相同、附加目标不同」的任务建不出来。
20. 目标去重 key 是 `(username || id) + threadId`；`Target.threadId` 优先于任务 `threadId`。
21. 所有外部输入（HTTP body、触发消息）先过 `normalizeTaskInput()` 收敛：截断长度、校验类型、限制 8 个目标。
22. 时间戳统一 **epoch 毫秒**；时区用 `Settings.timezone`（小时偏移，可为小数），**不要用 `Date` 的本地时区**。

### 指令 ↔ 任务必须往返

23. `dsl.ts` 的 `parseTrigger()` 与 `command.ts` 的 `taskToCommand()` 是一对互逆函数：
    **改任何一边都要在 `tests/roundtrip.test.ts` 加用例并跑通**。
    不可往返的内容（`#`/`btn:`/时间/链接开头的文本、含空格的 `rand:` 选项与关键词、含引号的名字）
    已经用 `say:` 前缀、统一加引号、`\"` `\\` 转义处理过，别为了「好看」删掉这些处理。

### 前端

24. 纯原生、零依赖、无构建：`public/{index.html,lib.js,app.js,editor.js,styles.css}`。
    只用 `styles.css` 顶部的 CSS 变量（`--bg` / `--panel` / `--accent` ...），不引框架、不引 CDN、不引外链字体。
25. **只用弹窗，不用抽屉。** 统一 `openModal({ size: "md" | "lg" })`（`lg` → `dialog-wide`：桌面 760px，
    ≤560px 全屏并避开安全区）。v0.10.2 已删除抽屉实现，别加回来。
26. 用户内容一律用 `textContent` / `el()` 的 `text` 属性，不要拼 `innerHTML`（XSS）。`innerHTML` 只用于清空。
27. 任务行的点击守卫用 `event.target instanceof Element` + `closest("button, a, input, ...")`
    （SVG `<path>` 不是 `HTMLElement`，v0.12.1 的坑）。`.row-actions` 带 `data-no-row-click`。
28. 界面上任何数字/状态都从服务端来，前端不 mock、不自己算下一个运行时间（`describeSchedule`/`formatCountdown` 只做格式化）。

---

## 架构地图

| 文件 | 职责 | 注意 |
| --- | --- | --- |
| `src/index.ts` | Worker 入口：登录/登出/session（HMAC Cookie）、安全头、`/api/*` 代理到 DO、`/api/version` | 除白名单外全部需要登录；`needsSetup` 表示没配 `ADMIN_PASSWORD` |
| `src/agent.ts` | `TgAgent` DO：账号登录向导、`alarm()` 调度、触发轮询、任务执行、JSON API | 最大的一块；所有执行走 `serialize()`；`scheduleNextAlarm()` 取最早事件 |
| `src/db.ts` | DO SQLite 的 `Store`：`kv` / `tasks` / `logs` / `events` / `auth_attempts` / `deletions` | 加列走 `ALTER TABLE` 迁移；`rows()` 统一 `.toArray()` |
| `src/types.ts` | 前后端共享类型 + `DEFAULT_SETTINGS`（唯一默认值来源） | 契约文档同步 `docs/API.md` |
| `src/task.ts` | 纯函数：`normalizeTaskInput` / `taskFingerprint` / `applyTargetPatch` / `taskToExport` | 好测，逻辑尽量往这里放 |
| `src/settings.ts` | 纯函数：`redactSettings` / `shouldAutoFillAdminId` | 脱敏只在这里做 |
| `src/events.ts` | 埋点计数分桶（7 天趋势） | 有 60 秒缓存 |
| `src/schedule/time.ts` | 时间解析、下次运行计算、时区格式化 | 纯函数，`tests/time.test.ts` |
| `src/schedule/dsl.ts` | 触发消息语法解析（`parseTrigger` / `tokenize` / 前缀 / 目标补全） | 改它必改往返测试 |
| `src/schedule/command.ts` | 任务 → 指令文本（`taskToCommand`） | 与 `dsl.ts` 互逆 |
| `src/schedule/guard.ts` | 到点判断 `decideRun`、连续失败熔断 `shouldAutoPause` | 纯函数 |
| `src/telegram/socket.ts` | `cloudflare:sockets` → teleproto `SocketInterface` | 多读者等待队列、连接超时关底层 socket |
| `src/telegram/transport.ts` | `CloudflareTransport`（`ConnectionTCPObfuscated` + 上面的 socket） | |
| `src/telegram/client.ts` | 建客户端、`withClient`、`isConnectionError`、DC 迁移 | 重试只认连接错误 |
| `src/telegram/executor.ts` | 执行步骤（text/random/click/number/wait）、轮询回复、成功判定、时间预算 | 步骤类型改动要同步 `taskBudgetMs` |
| `src/telegram/targets.ts` | 从消息推断目标（转发/回复/链接） | |
| `src/shims/*` | node 内建桩（构建期替换） | 改 `stubs` 映射见 `build.mjs` |
| `src/smoke.ts` | 冒烟 Worker 入口（不连 Telegram） | |
| `public/*` | 管理界面（纯静态） | 见上面「前端」约定 |
| `tests/*` | 零依赖测试；`harness.ts` 注册 → `index.test.ts` 汇总 | **新测试文件必须 import 进 `tests/index.test.ts`**，否则不跑 |
| `scripts/integration.mjs` | 端到端测试（进程组启动/整组 kill） | 动路由或 DO 行为时跑一遍 |
| `docs/API.md` / `docs/DEPLOY.md` / `docs/UI_COPY.md` | 接口契约 / 部署与排查 / 文案规范 | 改契约同步 API.md |
| `releases/unreleased.md` | 下一次发布的说明（改它即发版） | 格式与三种模式见「发版」一节 |
| `scripts/release.mjs` | 解析发布文档、校验版本递增、写 CHANGELOG、归档 | 只管文件改动，git/gh 在 workflow 里 |
| `deliverables/` | 审计报告与产品评审（历史决策依据） | 不是运行时产物 |

---

## 加东西时落在哪

| 要加的东西 | 改动路径（按顺序） |
| --- | --- |
| 新 API 端点 | `src/agent.ts` 的 `fetch()` 路由 → `docs/API.md` → 前端 `lib.js` 的 `api()` 调用方（`app.js`/`editor.js`） |
| 任务新字段 | `types.ts`（字段 + 默认）→ `task.ts` 的 `normalizeTaskInput`（裁剪/校验）→ `db.ts`（列 + 迁移 + `rowToTask`/读写）→ `API.md` → `editor.js` |
| 新 Step 类型 | `types.ts` 的 `StepType` → `dsl.ts` 解析（含 `tokenize` 引号/转义）→ `executor.ts` 执行 + `taskBudgetMs` 估算 → `command.ts` 往返 → `editor.js` 编辑 UI → `README.md` 语法表 → `tests/roundtrip.test.ts` |
| 新触发语法/修饰符 | `dsl.ts` → `command.ts` → `tests/{dsl,roundtrip}.test.ts` → `README.md` |
| 新设置项 | `types.ts`（`Settings` + `DEFAULT_SETTINGS`）→ `settings.ts`（若敏感则脱敏）→ `agent.ts` 读写与生效 → 前端设置页 → `docs/UI_COPY.md` |
| 界面改动 | `public/*`（先看 `styles.css` 变量与 `lib.js` 的 `el()`/`openModal()`），移动端 375px 必须验证 |

---

## 提交前检查清单

- [ ] `npm run check` 通过（typecheck + 140 例单测 + build + 产物导出检查）
- [ ] 改了路由 / DO 行为 / 数据读写 → `npm run test:integration` 通过
- [ ] 改了 `dsl.ts` 或 `command.ts` → 往返用例已补
- [ ] 改了 schema → 老数据能升级（`ALTER TABLE` 幂等）
- [ ] 新 API 响应有 `no-store`；敏感字段未回传
- [ ] 前端在 375px / 1280px 都看过，弹窗不是抽屉
- [ ] 面向使用者的改动写进了 `CHANGELOG.md` 的 `[Unreleased]`（中文，写「改了什么 + 为什么」）
- [ ] 要发版时：改 `releases/unreleased.md`（version 按「版本号约定」定档，正文写本次发布说明），
      先 `node scripts/release.mjs --dry-run` 预览；**不要**手动改 `package.json` 的版本号或手打 tag
- [ ] `dist/` 没被提交
