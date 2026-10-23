# cf-tg-checkin · 前端/后端接口契约

管理界面（`public/`）是纯静态资源，通过下面这些 HTTP 接口和 Worker 通信。
所有接口都是 `application/json`；除 `/api/login`、`/api/session`、`/api/logout` 外都需要登录 Cookie。
所有时间戳统一为 **epoch 毫秒**。
失败时返回 `{ "error": "原因" }` 且 HTTP 4xx/5xx。

## 认证

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/session` | – | `{ authenticated: boolean, needsSetup: boolean }` |
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
    "connected": false,          // 当前是否有活跃 MTProto 连接
    "pendingLogin": null | { "phone": "+861...", "stage": "code" | "password" },
    "lastError": "字符串或 null"
  },
  "settings": {
    "timezone": 8,               // 时区偏移（小时，可带小数）
    "pollSeconds": 60,           // 触发器轮询间隔
    "triggerEnabled": true,      // 是否监听触发消息
    "controlChat": "self",       // 触发消息来源会话：self=收藏夹，或 @username / 数字 id
    "adminUserId": "123",        // 允许用命令管理任务的管理员 tg id（可空）
    "defaultTarget": ""          // 触发消息解析不到目标时的兜底目标
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
  "target": { "kind": "user", "id": "7661096533", "title": "jerry bot", "username": "jerry_bot" },
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
  "deleteAfterSeconds": 0,          // >0 表示发送后 N 秒删除自己发的消息
  "cleanupPrevious": false,         // 每次执行前删掉上一次自己发的消息
  "nextRunAt": 1761234567000,   // epoch 毫秒
  "lastRunAt": 1761234000000,   // epoch 毫秒
  "lastResult": "ok",               // ok | fail | null
  "lastMessage": "签到成功",
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
| POST | `/api/tasks/run-all` | – | `{ ok: boolean, logs: [LogEntry] }` |
| GET | `/api/tasks/:id/logs?limit=20` | – | `{ logs: [LogEntry] }` |

## 日志

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| GET | `/api/logs?limit=100` | `{ logs: [LogEntry] }` |
| POST | `/api/logs/clear` | `{ ok: true }` |

## 设置

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/settings` | `Partial<Settings>` | `{ settings }` |

## Telegram 账号

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/account/send-code` | `{ apiId: number, apiHash: string, phone: string }` | `{ stage: "code" \| "password", hint?: string }` |
| POST | `/api/account/sign-in` | `{ code: string }` 或 `{ password: string }` | `{ ok: true, me }` / `{ stage: "password" }` |
| POST | `/api/account/logout` | – | `{ ok: true }` |
| POST | `/api/resolve` | `{ query: "@bot" \| "7661096533" \| "bot 昵称" }` | `{ peer: {kind,id,title,username} }` |

说明：`send-code` 需要先在 UI 里填 apiId/apiHash（从 https://my.telegram.org 获取）。
第二步返回 `{ stage: "password" }` 时表示账号开了两步验证，需要再提交 `{ password }`。

## 触发消息解析（用于 UI 里的“试算”）

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/trigger/parse` | `{ text: "9.30 签到 btn:立即签到 #kw:签到成功" }` | `{ ok: true, task: Task, explanation: string }` 或 `{ ok: false, error: string }` |

## 手动触发一次调度

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| POST | `/api/tick` | `{ ok: true, ran: [LogEntry], nextRunAt: number \| null }` |
