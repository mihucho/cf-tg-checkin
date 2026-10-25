# cf-tg-checkin · 前端/后端接口契约

管理界面（`public/`）是纯静态资源，通过下面这些 HTTP 接口和 Worker 通信。
所有接口都是 `application/json`；除 `/api/login`、`/api/session`、`/api/logout` 外都需要登录 Cookie。
所有时间戳统一为 **epoch 毫秒**。
失败时返回 `{ "error": "原因" }` 且 HTTP 4xx/5xx。

## 认证

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/session` | – | `{ authenticated: boolean, needsSetup: boolean }` |
| GET | `/api/version` | – | `{ version: "0.1.0", commit: "bbc176b", buildId: "2026-10-24T01:51:59Z", worker }`（**公开**，无需登录） |
| POST | `/api/login` | `{ password: string }` | `{ ok: true }`（同时下发 HttpOnly Cookie） |
| POST | `/api/logout` | – | `{ ok: true }` |

`needsSetup: true` 表示服务端还没配置 ADMIN_PASSWORD（需要在 Cloudflare 里设 secret）。

## 全局状态

`GET /api/state` →

```jsonc
{
  "account": {
    "configured": true,          // 是否已填 apiId/apiHash
    "apiId": 123456,             // 脱敏后可返回
    "phone": "+8613800000000",   // 脱敏显示由前端处理
    "signedIn": true,            // 是否已登录（有 session）
    "me": { "id": "123", "username": "neo", "firstName": "Neo" } | null,
    "connected": false,          // 当前是否有活跃 MTProto 连接（真值；空闲时就是 false）
    "lastConnectedAt": 1761234567890, // 最近一次成功连接的时间，null 表示还没连过
    "pendingLogin": null | { "phone": "+861...", "stage": "code" | "password" },
    "dc": 5 | null,             // 账号归属的 DC（登录时探测到才填）
    "lastError": "字符串或 null"
  },
  "settings": {
    "templates": [ /* 自定义模板：{ id, name, command }，最多 20 个，存服务端 */ ],
    "timezone": 8,               // 时区偏移（小时，可带小数）
    "storage": { "bytes": 106496, "limitBytes": 10737418240, "percent": 0 },  // DO 存储用量
    "pollSeconds": 60,           // 触发器轮询间隔
    "triggerEnabled": true,      // 是否监听触发消息
    "controlChat": "self",       // 触发消息来源会话：self=收藏夹，或 @username / 数字 id
    "adminUserId": "123",        // 允许用命令管理任务的管理员 tg id（可空）
    "defaultTarget": "",         // 触发消息解析不到目标时的兜底目标
    "stepPollSeconds": 3,        // 等下一步按钮/回复时，每隔多少秒查一次（1–30）
    "stepWaitSeconds": 30,       // 单次最多等多久（5–300）
    "notifyOnFailure": true,     // 任务失败时给自己发一条 Telegram 消息
    "notifyWebhook": "",         // 可选：失败提醒推送到这个地址
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
  },
  "tasks": [ Task ],
  "logs": [ LogEntry ],          // 最近 50 条
  "stats": {
    "totalTasks": 3,
    "enabledTasks": 2,
    "nextRunAt": 1761234567890,  // epoch 毫秒；无任务时为 null
    "lastRunAt": 1761234000000
  },
  "now": 1761234567890           // 服务器当前 epoch 毫秒，前端据此校正时钟
}
```

### Task

```jsonc
{
  "id": 1,
  "name": "xx bot 签到",
  "enabled": true,
  "target": { "kind": "user", "id": "7661096533", "title": "Jerry Bot", "username": "jerry_bot" },
  "targets": [ /* 可选：多目标，第一项与 target 相同，最多 8 个 */ ],
  "group": "日常签到",        // 可选：任务分组（≤20 字，空 = 未分组）
                                    // title 是 Telegram 里显示的群名/机器人名，任务名优先用它
  "threadId": null,                 // 群组话题 id
  "schedule": {
    "kind": "daily",                // daily | window | interval | once
    "time": "09:30",                // daily/once 用；window 用窗口起点
    "windowEnd": "10:30",           // window 用
    "intervalMinutes": 120,         // interval 用
    "jitterSeconds": 0              // 执行前随机延迟
  },
  "steps": [ Step ],
  "successKeywords": ["签到成功", "已签到"],
  "timeoutSeconds": 25,
  "stepDelaySeconds": 3,            // 每个动作之间默认等 3 秒（0 = 不等）
  "deleteAfterSeconds": 0,          // >0 表示发送后 N 秒删除自己发的消息
  "cleanupPrevious": false,         // 每次执行前删掉上一次自己发的消息
  "nextRunAt": 1761234567000,   // epoch 毫秒
  "lastRunAt": 1761234000000,   // epoch 毫秒
  "lastResult": "ok",               // ok | fail | null
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
  "detail": "…多行细节，可为 null"
}
```

## 任务管理

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/tasks` | Task（无 id） | `{ task }` |
| PATCH | `/api/tasks/:id` | 任意 Task 字段子集 | `{ task }` |
| DELETE | `/api/tasks/:id` | – | `{ ok: true }` |
| POST | `/api/tasks/:id/run` | – | `{ ok: boolean, log: LogEntry }` |
| GET | `/api/tasks/:id/command` | – | `{ command: string }`（把这个任务转成指令文本） |
| GET | `/api/tasks/export` | – | `{ format, version, exportedAt, tasks: TaskInput[] }`（去掉运行态字段，可备份/迁移） |
| POST | `/api/tasks/import` | `{ tasks: TaskInput[] }` | `{ ok, created, ids, skipped: [{name, reason}] }`（重复任务自动跳过） |
| POST | `/api/tasks/run-all` | – | `{ ok: boolean, logs: [LogEntry] }` |
| GET | `/api/tasks/:id/logs?limit=20` | – | `{ logs: [LogEntry] }` |

## 日志

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| GET | `/api/logs?page=1&pageSize=20&level=ok\|fail&taskId=<id>&q=<关键字>` | `{ logs: [LogEntry], total, page, pageSize, pages }` |
| POST | `/api/logs/clear` | `{ ok: true }` |
| POST | `/api/notify/test` | `{ notifyWebhookToken?, notifyWebhook?, notifyWebhookKind?, notifyWebhookSecret?, notifyEvents? }`（可选 overlay，用于测未保存的表单值） → `{ ok, result: { telegram, webhook } }` |
| POST | `/api/events` | `{ name: "failure_handled" \| "template_used" \| "command_copied" }` → `{ ok: true }`（白名单） |

日志用**页码分页**：`page`（从 1 开始，越界会自动收敛到最后一页）+ `pageSize`（1–100，默认 20），
响应带 `total` / `pages` 供前端渲染翻页条（`第 3 / 6 页 · 共 115 条`）。
也仍支持旧的游标参数 `before`（配合 `pageSize` 取更早的一页），返回 `nextBefore`。

`total` 是**当前筛选条件下**的总条数。

筛选参数：`level`（ok / fail / info…）、`taskId`（某个任务）、`q`（在 message / task_name 里模糊搜索，
LIKE 通配符已转义）。服务端只保留最近 2000 条。

## 设置

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/settings` | `Partial<Settings>` | `{ settings }` |

## Telegram 账号

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/account/send-code` | `{ apiId: number, apiHash: string, phone: string }` | `{ stage: "code" \| "password", hint?: string, dc?: number }` |
| POST | `/api/account/sign-in` | `{ code: string }` 或 `{ password: string }` | `{ ok: true, me }` / `{ stage: "password" }` |
| POST | `/api/account/logout` | – | `{ ok: true }` |
| POST | `/api/resolve` | `{ query: "@bot" \| "7661096533" \| "bot 昵称" }` | `{ peer: {kind,id,title,username} }` |

说明：`send-code` 需要先在 UI 里填 apiId/apiHash（从 https://my.telegram.org 获取）。
账号归属非 DC2 时 Telegram 返回 `PHONE_MIGRATE_n`，服务端会自动切到目标 DC 重试并记住它（`account.dc`）。
第二步返回 `{ stage: "password" }` 时表示账号开了两步验证，需要再提交 `{ password }`。

## 触发消息解析（用于 UI 里的“试算”）

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/trigger/parse` | `{ text: "tg 9.30 签到 btn:立即签到 #kw:签到成功" }` | `{ ok: true, task: Task, explanation: string, autoName?: boolean }` 或 `{ ok: false, error: string }` |
| POST | `/api/command` | `TaskInput` 草稿 | `{ command: string }`（编辑器「等价指令」实时预览用） |

## 手动触发一次调度

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| POST | `/api/tick` | `{ ok: true, ran: [LogEntry], nextRunAt: number \| null }` |
