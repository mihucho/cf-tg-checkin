# cf-tg-checkin · 前端/后端接口契约

管理界面（`public/`）是纯静态资源，通过下面这些 HTTP 接口和 Worker 通信。
所有接口都是 `application/json`；除 `/api/version`、`/api/login`、`/api/session`、`/api/logout` 外都需要登录 Cookie。
所有 `/api` 响应都带 `cache-control: no-store`。
所有时间戳统一为 **epoch 毫秒**。
失败时返回 `{ "error": "原因" }` 且 HTTP 4xx/5xx。

## 认证

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/session` | – | `{ authenticated: boolean, needsSetup: boolean, turnstileSiteKey: string \| null }` |
| GET | `/api/update-check?refresh=1` | – | `{ current, latest, hasUpdate, url }`（读取 GitHub `main` 的 `package.json` 作为最新版本，含未打 tag 的版本；附带最新 Release 链接；缓存 6 小时，构建 ID 变化自动失效，`refresh=1` 强制刷新） |
| GET | `/api/version` | – | `{ version: "0.19.2", commit: "e0d50af", buildId: "2026-10-25T01:51:59Z", worker: "cf-tg-checkin" }`（**公开**，无需登录） |
| POST | `/api/login` | `{ password: string, turnstileToken?: string }` | `{ ok: true }`（同时下发 HttpOnly Cookie）；失败可能返回 429 + `Retry-After` |
| POST | `/api/logout` | – | `{ ok: true }`（清除 Cookie；跨站 Origin 会被 403 拒绝） |

`needsSetup: true` 表示服务端还没配置 ADMIN_PASSWORD（需要在 Cloudflare 里设 secret）。
配置了 Turnstile 时，登录必须带 `turnstileToken`；未配置时该字段可省略。

## 全局状态

`GET /api/state` →

```jsonc
{
  "account": {            // 敏感字段已脱敏：phone → +861****0000，me.id → 765****321，apiId → 1234****
    "configured": true,          // 是否已填 apiId/apiHash
    "apiId": 123456,             // 脱敏后的字符串（类型上仍按 number 占位）
    "phone": "+861****0000",     // 服务端已脱敏
    "signedIn": true,            // 是否已登录（有 session）
    "me": { "id": "765****321", "username": "example_user", "firstName": "示例用户" } | null,
    "connected": false,          // 当前是否有活跃 MTProto 连接（真值；空闲时就是 false）
    "lastConnectedAt": 1761234567890, // 最近一次成功连接的时间，null 表示还没连过
    "pendingLogin": null | { "phone": "+861****0000", "stage": "code" | "password" },
    "dc": 5 | null,             // 账号归属的 DC（登录时探测到才填）
    "lastError": "字符串或 null"
  },
  "settings": {
    "templates": [ /* 自定义模板：{ id, name, command }，最多 20 个，存服务端 */ ],
    "timezone": 8,               // 时区偏移（小时，可带小数）
    "pollSeconds": 60,           // 触发器轮询间隔
    "triggerEnabled": true,      // 是否监听触发消息
    "controlChat": "self",       // 触发消息来源会话：self=收藏夹，或 @username / 数字 id
    "adminUserId": "765****321", // 脱敏值；用 adminUserIdConfigured 判断是否已配置
    "adminUserIdConfigured": true,
    "defaultTarget": "",         // 触发消息解析不到目标时的兜底目标
    "stepPollSeconds": 3,        // 等下一步按钮/回复时，每隔多少秒查一次（1–30）
    "stepWaitSeconds": 30,       // 单次最多等多久（5–300）
    "notifyOnFailure": true,     // 任务失败时给自己发一条 Telegram 消息
    "notifyWebhook": "",         // 脱敏值（如 ?access_token=abcd****cdef）；留空保存 = 不修改
    "notifyWebhookConfigured": false, // 只读：地址是否已配置
    "notifyWebhookKind": "generic", // 推送渠道：dingtalk | wecom | feishu | generic（自定义渠道）
                                    // 日报/周报：dingtalk+wecom 用 markdown 包体，feishu 用交互卡片
    "notifyWebhookSecret": "",   // 钉钉加签密钥：永远不回传，用 notifyWebhookSecretConfigured 表示是否已配
    "notifyWebhookSecretConfigured": false,
    "notifyEvents": ["run_failed", "auto_paused", "session_expired", "connection_error", "daily_digest"],
    "digestHour": 22,            // 日报时间（本地时区小时，0-23）
    "digestWeekday": 0,          // 周报发送日（0=周一 … 6=周日）
    "weeklyHour": 22,            // 周报时间（本地时区小时）
    "storageWarnPercent": 70,    // 存储告警阈值（%，0=关闭）
    "successRateThreshold": 80,  // 成功率告警阈值（%，0=关闭；窗口 7 天、样本≥3）
    "triggerPrefix": "tg",       // 触发前缀（默认 "tg"）：只有以它开头的消息才当配置解析；空字符串=全部解析
    "turnstileSiteKey": "",      // 公开的 Turnstile Site Key（配了才在登录页出现验证框）
    "turnstileSecretConfigured": false // 只读：服务端是否已配置 Turnstile Secret（值永不回传）
  },
  "tasks": [ Task ],
  "logs": [ LogEntry ],          // 最近 50 条
  "stats": {
    "totalTasks": 3,
    "enabledTasks": 2,
    "nextRunAt": 1761234567890,  // epoch 毫秒；无任务时为 null
    "lastRunAt": 1761234000000
  },
  "now": 1761234567890,          // 服务器当前 epoch 毫秒，前端据此校正时钟
  "events": {                    // 埋点计数（只统计次数/时间，不采集内容）
    "firstLoginAt": 1761000000000,
    "tasksCreated": { "ui": 3, "trigger": 1 },
    "runs": { "ok": 42, "fail": 3 },
    "failureHandled": 1,
    "trend": [ { "date": "10-24", "ok": 5, "fail": 0 } ] // 最近 7 天
  },
  "notifyCatalog": [ { "id": "run_failed", "label": "执行失败", "hint": "…", "throttled": true } ],
  "runtime": {
    "build": { "version": "0.19.2", "buildId": "…", "commit": "e0d50af" },
    "storage": { "bytes": 106496, "limitBytes": 10737418240, "percent": 0 },
    "colo": "SJC",
    "locationHint": null,
    "nextPollAt": 1761234567890,
    "lastPollAt": 1761234500000,
    "lastTriggerEvent": { "at": 1761234500000, "ok": true, "message": "触发器命令：列表" },
    "pollSeconds": 60
  }
}
```

### Task

```jsonc
{
  "id": 1,
  "name": "xx bot 签到",
  "nameAuto": true,                 // 任务名是否由系统自动生成（false = 用户起的，不允许被目标补全改名）
  "enabled": true,
  "target": {
    "kind": "user",                 // user | chat | channel
    "id": "123456789",
    "title": "示例机器人",           // Telegram 里显示的群名/机器人名
    "username": "example_bot",
    "accessHash": "…",              // 仅导出/内部使用；/api/state 会剥离
    "threadId": 12,                 // 可选：该目标的话题 id（优先于任务级 threadId）
    "peerKind": "bot"               // bot | user | group | channel（执行时补全）
  },
  "targets": [ /* 可选：多目标，第一项与 target 相同，最多 8 个 */ ],
  "group": "日常签到",        // 可选：任务分组（≤20 字，空 = 未分组）
  "threadId": null,                 // 群组话题 id
  "schedule": {
    "kind": "daily",                // daily | window | interval | once
    "time": "09:30",                // daily/once 用；window 用窗口起点
    "windowEnd": "10:30",           // window 用
    "intervalMinutes": 120,         // interval 用（1–10080）
    "jitterSeconds": 0              // 执行前随机延迟（0–3600）
  },
  "steps": [ Step ],
  "successKeywords": ["签到成功", "已签到"],
  "timeoutSeconds": 30,             // 5–90
  "stepDelaySeconds": 3,            // 每个动作之间默认等 3 秒（0 = 不等）
  "deleteAfterSeconds": 0,          // >0 表示发送后 N 秒删除自己发的消息（0–3600）
  "cleanupPrevious": false,         // 每次执行前删掉上一次自己发的消息
  "nextRunAt": 1761234567000,   // epoch 毫秒
  "lastRunAt": 1761234000000,   // epoch 毫秒
  "lastResult": "ok",               // ok | fail | null
  "lastRunSource": "auto",          // auto | manual | null（手动执行不吃当天定时名额）
  "failStreak": 0,                  // 连续失败次数（成功清零；到 3 自动停用）
  "lastMessage": "签到成功",
  "lastDetail": "· 步骤1 发送「/start」\n· 步骤2 点击「个人资料」…",   // 最近一次运行的逐步日志
  "source": "ui",                   // ui | trigger
  "createdAt": 1761200000000,   // epoch 毫秒
  "updatedAt": 1761200000000    // epoch 毫秒
}
```

### Step

```jsonc
{ "type": "text",   "text": "签到" }                    // 发送文本
{ "type": "random", "options": ["早安", "晚上好"] }      // 随机挑一条发送
{ "type": "click",  "text": "立即签到" }                 // 按文本点按钮
{ "type": "click",  "row": 0, "column": 1 }             // 按行列点按钮（0 基）
{ "type": "number", "value": "1" }                      // 直接发送数字（数字键盘类 bot）
{ "type": "wait",   "seconds": 3 }                      // 等待 N 秒
```

### LogEntry

```jsonc
{
  "id": 12,
  "taskId": 1,
  "taskName": "xx bot 签到",
  "at": 1761234000000,          // epoch 毫秒
  "ok": true,
  "level": "info",             // info | warn | error
  "message": "签到成功",
  "detail": "…多行细节，可为 null",
  "source": "auto",            // auto | manual | trigger | system（老日志可能为 null）
  "durationMs": 12345          // 执行耗时（毫秒），只有执行类日志有
}
```

## 任务管理

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/tasks` | Task（无 id） | `{ task }` |
| PATCH | `/api/tasks/:id` | 任意 Task 字段子集 | `{ task }` |
| DELETE | `/api/tasks/:id` | – | `{ ok: true }` |
| POST | `/api/tasks/:id/run` | – | `{ ok: boolean, log: LogEntry }`；任务正在执行时返回 409 |
| GET | `/api/tasks/:id/live` | – | 实时执行状态：`{ taskId, taskName, startedAt, finishedAt, running, ok, message, events: [{ at, level, message }] }` |
| GET | `/api/tasks/:id/command` | – | `{ command: string }`（把这个任务转成指令文本） |
| POST | `/api/tasks/:id/clone` | – | `{ task }`（复制一份，名字加「副本」、默认停用） |
| POST | `/api/tasks/batch-update` | `{ ids: number[], enabled?: boolean, group?: string }` | `{ ok, updated }`（一次改多个任务的启停/分组） |
| POST | `/api/tasks/delete-batch` | `{ ids: number[] }`（最多 200 个） | `{ ok: true, deleted: number }` |
| POST | `/api/tasks/group-rename` | `{ from: string, to: string }`（`from` 为空 = 未分组） | `{ ok, updated, from, to }` |
| GET | `/api/tasks/export` | `group`（可选：分组名；`__ungrouped` = 未分组；不传 = 全部） | `{ format, version, exportedAt, tasks: TaskInput[] }`（去掉运行态字段，可备份/迁移） |
| POST | `/api/tasks/import` | `{ tasks: TaskInput[], group?: string }`（`group` = 没分组的任务落到哪个分组） | `{ ok, created, ids, skipped: [{name, reason}] }`（重复任务自动跳过） |
| POST | `/api/tasks/run-all?limit=8&offset=0&group=名称` | –（`__ungrouped` = 只跑未分组） | `{ ok, logs, processed, remaining, nextOffset }`（分批执行，前端按 `nextOffset` 续跑） |
| GET | `/api/tasks/:id/logs?limit=20&before=<id>` | – | `{ logs: [LogEntry] }` |

### 实时执行日志

`POST /api/tasks/:id/run` 启动执行后，`GET /api/tasks/:id/live` 返回当前进度：

- `running`：是否仍在执行；
- `events`：按时间排列的步骤输出（`info` / `warn` / `error`），最多保留 200 条；
- `ok` / `message`：执行结束后的最终结果；
- 执行结束后状态保留 5 分钟；实例被回收时状态标记为「执行中断」。

## 日志

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| GET | `/api/logs?page=1&pageSize=20&level=ok\|fail&taskId=<id>&q=<关键字>&sinceHours=24` | `{ logs: [LogEntry], total, page, pageSize, pages }` |
| POST | `/api/logs/clear` | `{ ok: true }` |
| POST | `/api/notify/test` | `{ notifyWebhookToken?, notifyWebhook?, notifyWebhookKind?, notifyWebhookSecret?, notifyEvents? }`（可选 overlay，用于测未保存的表单值） → `{ ok, result: { telegram, webhook } }` |
| POST | `/api/events` | `{ name: "failure_handled" \| "template_used" \| "command_copied" }` → `{ ok: true }`（白名单） |

日志用**页码分页**：`page`（从 1 开始，越界会自动收敛到最后一页）+ `pageSize`（1–100，默认 20），
响应带 `total` / `pages` 供前端渲染翻页条（`第 3 / 6 页 · 共 115 条`）。
也仍支持旧的游标参数 `before`（配合 `pageSize` 取更早的一页），返回 `nextBefore`。

`total` 是**当前筛选条件下**的总条数。

筛选参数：`level`（ok / fail / info…）、`taskId`（某个任务）、`q`（在 message / task_name 里模糊搜索，
LIKE 通配符已转义）、`sinceHours`（只看最近 N 小时）。`limit` 是 `pageSize` 的别名。服务端只保留最近 2000 条。

## 设置

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/settings` | `Partial<Settings>` + 清除标志 | `{ settings }`（统一脱敏） |

清除/特殊字段（不进 `Settings` 本体）：

```jsonc
{
  "notifyWebhookToken": "机器人 Token",   // 固定渠道用；空值或含 **** 表示不修改
  "clearNotifyWebhook": true,            // 清空 Webhook 地址
  "clearNotifyWebhookSecret": true,      // 清空钉钉加签密钥
  "clearAdminUserId": true,              // 清空管理员 ID，并停止自动回填
  "clearTurnstileSecret": true           // 清空 Turnstile Secret
}
```

敏感字段（Turnstile Secret、钉钉加签密钥）永远不回传，只返回 `*Configured: boolean`；
Webhook 地址与管理员 ID 返回脱敏值，留空保存表示不修改。

## Telegram 账号

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/account/send-code` | `{ apiId: number, apiHash: string, phone: string }` | `{ stage: "code" \| "password", hint?: string, dc?: number }` |
| POST | `/api/account/sign-in` | `{ code: string }` 或 `{ password: string }` | `{ ok: true, me }` / `{ stage: "password" }` |
| POST | `/api/account/logout` | – | `{ ok: true }` |
| POST | `/api/resolve` | `{ query: "@bot" \| "123456789" \| "bot 昵称" }` | `{ peer: {kind,id,title,username} }` |

说明：`send-code` 需要先在 UI 里填 apiId/apiHash（从 https://my.telegram.org 获取）。
账号归属非 DC2 时 Telegram 返回 `PHONE_MIGRATE_n`，服务端会自动切到目标 DC 重试并记住它（`account.dc`）。
第二步返回 `{ stage: "password" }` 时表示账号开了两步验证，需要再提交 `{ password }`。

## 触发消息解析（用于 UI 里的“试算”）

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/trigger/parse` | `{ text: "tg 9.30 签到 btn:立即签到 #kw:签到成功" }` | 建任务：`{ ok: true, task: Task, explanation, autoName? }`；管理命令：`{ ok: true, command: "list" \| "run" \| …, argument }` 或 `{ ok: false, error }` |
| POST | `/api/command` | `TaskInput` 草稿 | `{ command: string }`（编辑器「等价指令」实时预览用） |

## 手动触发一次调度

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| POST | `/api/tick` | `{ ok: true, ran: [LogEntry], nextRunAt: number \| null }` |

## 仅 Worker → DO 内部调用

下面这些端点只给 Worker 内部使用（`proxyToAgent` 会重建请求头，外部无法注入标记），
不属于对外契约，仅供 Worker 内部调用：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/auth/turnstile` | 读取 Turnstile 配置（要求 `x-internal-call: turnstile`） |
| POST | `/api/auth/attempt` | 登录失败限速计数（Worker 代理调用） |
| POST | `/api/notify/event` | 登录锁定等 Worker 侧事件通知（要求 `x-internal-call: notify`） |
