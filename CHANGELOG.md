# 更新日志

版本号只在 `package.json` 里维护（构建时注入到产物，页面底部和 `GET /api/version` 都会显示它）。

发版流程：

```bash
npm version patch      # 或 minor / major：改 package.json + 生成 commit 和 tag
git push --follow-tags # 触发部署（Workers Builds / GitHub Actions）
```

## [Unreleased]

## [0.2.0] - 2026-10-24

这一版集中在「让它真的能签到成功」和「出问题能看见」。

### 新增

- **步骤日志**：任务列表「最近结果 → 步骤日志」弹窗展示最近一次运行的每一步
  （发送内容、消息上有哪些按钮、点击类型、机器人回应、失败原因），完整历史仍在「日志」页
- **`@here`**：目标是当前会话（在群里发配置不用再指定目标）；`指向顺序`：显式目标 → `@here`
  → 转发/回复来源 → 最近登记的目标 → 默认目标
- **步骤间隔**：每个动作之间默认停 3 秒（任务级 `#delay:N`，`#delay:0` 关掉）
- **步骤检测**：设置里可配「检测间隔（默认 3 秒）/ 最多等待（默认 30 秒）」
- **`/api/version`**：公开返回 `{ version, commit, buildId }`，页面底部/登录页/设置页都会显示

### 修复

- **按钮点不动**：layer 232 的 inline 按钮是 `KeyboardInlineButton { type: InlineButtonTypeCallback { data } }`，
  之前按旧结构读 `data` 导致「匹配上了但点不动」。现在新旧结构都认，并区分 url / webview / switch_inline
- **按钮文本带图标**：比较前去掉空格/emoji/标点，「👤 个人资料」可匹配「个人资料」
- **`Could not find the input entity`**：解析数字 id 需要 access_hash。目标优先用 `@username`、
  建任务时保存 `access_hash`、实体缓存落地到 DO、失败时 `getDialogs()` 预热重试
- **`PHONE_MIGRATE_n`**：`requestRetries` 过小导致 DC 迁移策略没跑；现在自动切到目标 DC 重试并记住 DC
- **时间不在第一个位置也能解析**：`https://t.me/x 9 /start …`、`@bot 9.30 签到` 都认；
  `https://…` 不再被误当成键值对
- **只转发机器人不再刷「缺少时间」**：无时间但有目标时只做「目标登记」（30 分钟内有效），静默不回复
- **手动触发不打乱定时**：立即执行不改变 `nextRunAt`（除非本来就到期），也不会提前消费 `once` 任务
- **`/api/*` 加 `cache-control: no-store`**：避免浏览器启发式缓存读到旧状态

### 部署

- `npm run deploy` 前会自检产物是否导出 `TgAgent`（挡住 `does not export class 'TgAgent'` 那类事故）
- `keep_vars: true`：CLI 部署不再清掉控制台里加的变量
- 新增 `docs/DEPLOY.md`「确认线上跑的是哪一版」排查法

## [0.1.0] - 2026-10-24

首个可用版本。

### 功能

- 定时签到：每天固定时刻 / 时间窗口内随机 / 每 N 小时，支持执行前随机延迟
- 多步骤动作：发文本 → 轮询机器人回复 → 按文本或行列点 inline 按钮 → 继续下一层 → 关键词判定
- 消息即配置：在收藏夹（或自定义控制会话）发一条 `9.30 签到` 即建任务；
  转发/分享机器人消息时自动推断目标（fwdFrom / 联系卡片 / t.me 链接）
- 每天一条随机消息：`8.30-9.30 rand:早安|午安|晚上好 @群`
- 管理界面：概览 / 任务（动作流水线编辑器）/ 日志 / 账号三步登录向导 / 设置（含 DSL 试算）
- 状态与数据全部落在 Durable Object 内嵌 SQLite，不需要 D1 / KV

### 部署

- 一键部署按钮、Workers Builds、GitHub Actions、本地 wrangler 四种方式
- `npm run deploy` 内置产物自检（校验 Durable Object 类导出）
- `GET /api/version` 与页面底部显示 `版本 · commit · 构建时间`

### 修复

- 登录：`PHONE_MIGRATE_n`（账号不在 DC2）自动切 DC 并重试
- 前端：`/api/*` 响应加 `cache-control: no-store`，避免读到缓存里的旧状态
