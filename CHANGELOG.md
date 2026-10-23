# 更新日志

版本号只在 `package.json` 里维护（构建时注入到产物，页面底部和 `GET /api/version` 都会显示它）。

发版流程：

```bash
npm version patch      # 或 minor / major：改 package.json + 生成 commit 和 tag
git push --follow-tags # 触发部署（Workers Builds / GitHub Actions）
```

## [Unreleased]

## [0.3.7] - 2026-10-24

- 修「识别到显示名了，任务名还是 @username」：建任务时 `enrichTarget` 只补了目标、没改名字。
  新增 `renameForTarget()`（纯函数，有单测）：目标从「只有 @username」补全出显示名时，
  把当初自动生成的任务名同步替换；用户自己起的名字不动
- 执行时的自动补全也复用同一逻辑，不再有两套前缀替换代码

## [0.3.6] - 2026-10-24

- 触发器事件不再只存在于日志列表：每次处理触发消息都会写一份 `trigger:lastEvent`，
  在概览「触发器」卡片底部常显「最近事件：触发器创建任务 #N（2 分钟前）」——
  即使日志被「成功/失败」筛选挡住、或只看了概览前 5 条，也能确认触发到底有没有跑

## [0.3.5] - 2026-10-24

触发器彻底可见（之前只有"创建成功"才写日志，failure/忽略全静默）：

- 每条被处理的触发消息都记一条日志，detail 含完整链路：消息 id / out / senderId / 控制会话 →
  推断到的目标 → 上下文（默认目标、记住的目标）→ 解析结果或失败原因 → 调度 → 动作
- 被忽略的情况也记：非管理员、群聊非本人、超长/空消息
- 每轮轮询发现新消息时记一条「触发器轮询：发现 N 条新消息」+ 消息预览
- 首次轮询（或换了控制会话）记一条「记录游标 #N，之前的历史不处理」
- 概览「触发器」卡片显示「上次轮询 x 分钟前」，超过 3 个周期标 ⚠️ 已超时

## [0.3.4] - 2026-10-24

- 触发识别过程写进日志：新建任务时记一条「触发器创建任务 #id」，detail 里是完整链路
  （触发文本 → 推断到的目标 → 解析结果 or **失败原因** → 调度 → 动作）
- `enrichTarget` 不再静默吞异常：解析失败会把错误原文写进日志
- 解析兜底加一层：`contacts.resolveUsername` 失败时，直接在自己最近 200 个对话里按 username 找实体

## [0.3.3] - 2026-10-24

- 修「从链接建任务抓不到机器人显示名」：`https://t.me/xxx_bot 7.40 /sign` 这类消息里，
  DSL 从链接解析出的目标只有 username，覆盖了能拿到显示名的推断结果。
  现在建任务前会解析一次实体，补上 `title` / `accessHash`，任务名变成「签到小助手 /sign」
- 执行时若目标缺 `title`，也会自动补全，并把当初按 `@username` 自动生成的任务名同步换成显示名
- `/api/trigger/parse` 试算也会做同样的补全（已登录时）

## [0.3.2] - 2026-10-24

- 修正「MTProto 连接」状态：之前 `connected` 是硬编码的 `false`（永远显示"待连接"），
  现在反映真实连接状态，并显示「上次成功连接 x 分钟前」
- 概览的触发器卡片显示「下次轮询 HH:MM:SS」，不再让人误以为"必须在连接状态才能用"
- `/api/state` 增加 `account.lastConnectedAt` 与 `runtime.nextPollAt` / `runtime.pollSeconds`

## [0.3.1] - 2026-10-24

- Turnstile 支持**在设置页直接配置**（Site Key / Secret Key / 清除），保存即生效，无需重新部署
- 环境变量仍然优先于设置页（两者都配时用 env）；Secret 只存服务端，接口恒回传空串 + `turnstileSecretConfigured` 标记
- Worker 侧对 Turnstile 配置做 30 秒缓存，设置保存后立即失效
- 前端进登录页时若本地没有 Site Key 会现拉 `/api/session`，配置完登出即可看到验证框

## [0.3.0] - 2026-10-24

- 新增 **Cloudflare Turnstile** 人机验证（可选）：配 `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` 后
  登录页出现验证框，服务端 `siteverify` 校验通过才发 Cookie；校验失败计入登录限速；
  校验服务不可用时 fail-closed。未配置时行为与之前一致
- `/api/session` 返回 `turnstileSiteKey`（公开），前端据此按需加载 widget
- CSP 放行 `https://challenges.cloudflare.com`（脚本 / iframe / 连接）
- docs/DEPLOY.md 新增 Turnstile 配置章节（含官方测试 key）

## [0.2.3] - 2026-10-24

- 日志列表改为**游标分页**：`/api/logs?before=<id>&level=&taskId=`，前端「加载更早的日志」
  （比页码稳，插入新日志不会跳行）；新增「全部 / 成功 / 失败」筛选
- 服务端日志保留条数 500 → 2000

## [0.2.2] - 2026-10-24

安全加固（详见 [SECURITY.md](SECURITY.md)，含实测记录）：

- 登录限速：同 IP 10 次失败 / 10 分钟 → 429 + `Retry-After`，锁定期内正确密码也拒绝
- 请求体上限 64 KB；输入长度全部设上限（任务名 80 / 步骤文本 500 / 关键词 20×60 …）
- `?limit=abc` 之类参数不再把 SQLite 错误原文吐给前端
- 状态变更接口校验 `Origin`（CSRF 纵深防御，Cookie 仍是 SameSite=Lax + HttpOnly + Secure）
- 安全响应头：CSP / nosniff / X-Frame-Options / Referrer-Policy / Permissions-Policy
- 群聊控制会话且未配 `adminUserId` 时，只接受本人发出的触发消息
- 登录态 TTL 30 天 → 7 天；`findTask` 的 LIKE 通配符转义

## [0.2.1] - 2026-10-24

- 修复「按钮类型不支持点击」：layer 232 的普通键盘按钮是
  `KeyboardButton { text, type: ButtonTypeDefault }`（没有 data/url），之前被判成 unknown。
  现在按「发文本」处理（等价于用户按下键盘按钮），未识别类型也会先试发文本，
  最后才尝试 teleproto 自带的 `MessageButton.click()`
- 按钮日志带上类型：`[3,0] 个人资料 (text,ButtonTypeDefault)`；匹配不到时打印原始 replyMarkup
- 单测 +2（ButtonTypeDefault、KeyboardInlineButton 回调/链接），共 39 个

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
