# 安全审计记录

> 适用版本：0.2.2 起。每次新增攻击面（新接口、新输入）都应在这里补一行。
> 审计方式：本地 `wrangler dev` 起真实 workerd + curl/浏览器实攻，不只是读代码。

## 威胁模型

| 角色 | 能力 | 应该能做什么 | 不该能做什么 |
| --- | --- | --- | --- |
| 匿名互联网用户 | 能访问 `*.workers.dev` | 看登录页、`GET /api/version`、`GET /api/session` | 读任务/日志/配置、触发任何操作 |
| 持有 ADMIN_PASSWORD 的人 | 能登录 | 管理任务、登录 Telegram、执行签到 | —（单管理员模型） |
| 控制会话里能发言的人 | 能在收藏夹/群里发消息 | 在 `self`（收藏夹）里就是本人 | 若控制会话是群且未配 `adminUserId`，**不能**指挥这个账号 |
| 目标机器人 | 能给账号发消息 | — | 不能让账号做任何操作（机器人消息被忽略） |
| Cloudflare | 托管方 | — | 不属于本项目的防护范围 |

**核心资产**：Telegram session（等价于账号登录态）、`api_id`/`api_hash`、ADMIN_PASSWORD。
这些只存在 Worker secret 与 DO 内嵌 SQLite 里，从不出现在接口响应或前端。

## 本轮实测结论

| # | 攻击 | 期望 | 实测 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 未带 Cookie 访问 `/api/state`、`/api/logs`、`/api/tasks/1/run` | 401 | 401 | ✅ |
| 2 | 伪造 Cookie：空签名 / 乱签名 / 错版本前缀 / 空值 | 401 | 401 | ✅ |
| 3 | 用正确密钥签的**过期** token | 401 | 401 | ✅ |
| 4 | 篡改签名末位 / 篡改 exp（不改签名） | 401 | 401 | ✅ |
| 5 | 路径绕过：`/api/../api/state`、`/api//state`、`/api/%73tate`、`/api/state/` | 401 | 401 | ✅ |
| 6 | `/API/state`（大写） | 落到静态资源（SPA fallback），不泄露数据 | 200 = index.html | ✅（只是页面） |
| 7 | 公开端点泄露 | 只有版本信息 | `/api/version` 仅 `version/commit/buildId` | ✅ |
| 8 | `XSS`：任务名/目标名/步骤文本塞 `<img onerror>` `<script>` | 纯文本渲染 | DOM 里 0 个 img/script，无 alert | ✅ |
| 9 | SQL 注入：`?limit=abc` / `?limit=1 OR 1=1` / `?limit[]=1` | 不报错、不泄露 SQL | 参数非法时回落默认值 | ✅（已修） |
| 10 | 登录爆破：错误密码 ×20 | 触发限速 | 第 10 次起 429 + `Retry-After` | ✅（已修） |
| 10b | 配了 Turnstile 时：无 token / 错误 token | 400 拒绝 | `请先完成人机验证` / `人机验证未通过（invalid-input-response）` | ✅ |
| 10c | Turnstile Secret 是否会回传给前端 | 不回传 | `/api/settings` 与 `/api/state` 里 `turnstileSecretKey` 恒为空，只有 `turnstileSecretConfigured: true` | ✅ |
| 11 | 锁定期内用**正确**密码 | 仍然 429 | 429 | ✅（限速不可绕过） |
| 12 | 超大请求体（1 MB） | 413 | 413 | ✅（已修） |
| 13 | 超长触发文本（200 KB） | 拒绝或截断 | 413（body 上限）/ 解析时截到 2000 字符 | ✅（已修） |
| 14 | 跨站写请求（`Origin: https://evil.example` + Cookie） | 403 | 403 | ✅（已修） |
| 15 | 并发 10 次「立即执行」 | 串行排队、不重复并发 | 全部 200，DO 内串行 | ✅ |
| 16 | 群聊控制会话里非本人发言指挥账号 | 忽略并记日志 | 非 `self` 且未配 `adminUserId` 时忽略 | ✅（已修） |
| 17 | 安全响应头 | 有 CSP / nosniff / 防 iframe | 见下 | ✅（已修） |
| 18 | 构建产物 / 仓库是否残留密钥 | 无 | `grep` 无 `dev-password`；`.dev.vars` 未入库 | ✅ |

### 安全响应头（实测）

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

`/api/*` 额外固定 `Cache-Control: no-store`（避免状态被缓存）。

## 本轮修复

| 问题 | 修复 | 位置 |
| --- | --- | --- |
| `?limit=abc` 把 `SQLITE_MISMATCH` 原文返回给前端 | `intParam()` 严格解析；`publicError()` 把 DB 类错误统一成「请求参数不合法」 | `src/agent.ts` |
| 输入长度无上限（1 MB 任务名能落库） | 名称 80 / 句柄 80 / 步骤文本 500 / 关键词 20×60 / 步骤数 20 / 随机选项 10；`threadId`、行列号也做范围校验 | `src/agent.ts` `normalizeTaskInput` |
| 请求体无上限 | 64 KB（先看 `content-length`，再校验实际长度） | `src/index.ts` |
| 登录无限制 | 同 IP 10 次失败 / 10 分钟 → 429 + `Retry-After`；计数在 DO SQLite（多 colo 一致）；锁定期间正确密码也拒绝 | `src/index.ts` + `src/agent.ts` `/auth/attempt` + `src/db.ts` |
| 无 CSRF 纵深防御 | 状态变更方法校验 `Origin` 与本站 host 一致；Cookie 本来就是 `SameSite=Lax; HttpOnly; Secure` | `src/index.ts` |
| 无安全响应头 | 新增 `public/_headers`（CSP 等）+ API 响应头 | `public/_headers`、`src/index.ts` |
| 群聊控制会话可被任意成员指挥 | 非 `self` 且未配 `adminUserId` 时只接受本人发出的消息，并记一条 warn 日志 | `src/agent.ts` |
| 登录态无法吊销 | TTL 30 天 → 7 天；改 `ADMIN_PASSWORD` / `SESSION_SECRET` 可让全部旧 Cookie 立即失效 | `src/index.ts` |
| `findTask` 的 LIKE 未转义通配符 | 按名称查找任务时转义 `%` `_` | `src/db.ts` |

## 残余风险（已知、可接受）

1. **单口令、无二次认证**：口令泄露即等于管理员。已提供两层可选加固：Cloudflare Turnstile 人机验证（防脚本爆破）与 Cloudflare Access 身份代理（防口令泄露）。建议叠加 Cloudflare Access（邮箱/SSO 身份代理）或放在内网/私有域名后：
   配置步骤见 [docs/DEPLOY.md](docs/DEPLOY.md#用-cloudflare-access-兜一层可选强烈建议)，
   并用 `ALLOWED_HOSTS` 关掉 `workers.dev` 旁路（否则 Access 可以被绕开）。
2. **无状态 Cookie 不能单点吊销**：只能靠缩短 TTL 或换密钥全局失效（已把 TTL 降到 7 天）。
3. **`api_id` 与 session 存在 DO 里**：Cloudflare 侧可见；这是托管模型的固有信任。
4. **Telegram 侧风险**：数据中心出口 IP 登录用户账号，极端情况下会要求重新验证（不是封号）；详见 README「关于 Telegram 侧的 IP / 封号风险」。
5. **控制会话是群时依赖 `adminUserId`**：没配就只能本人发言（已限制），但账号本身能往任意目标发消息 —— 这是功能，不是漏洞。
6. **`/api/tasks/run-all` 会让一次请求跑完全部任务**：耗时可能超过浏览器等待，但 DO 侧串行、不会并发爆炸。
7. **限速按 IP**：Cloudflare 视角的客户端 IP，NAT 后的多人会共享额度（单管理员场景无所谓）。

## 自测脚本（本地）

```bash
npx wrangler dev --port 8800 &        # 另开一个终端

# 未认证
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8800/api/state           # 401

# 伪造 Cookie
curl -s -o /dev/null -w '%{http_code}\n' -H 'cookie: tg_checkin=v1.99999999999999.x' \
  http://127.0.0.1:8800/api/state                                                  # 401

# 登录 + 参数异常
curl -s -c /tmp/ck -X POST http://127.0.0.1:8800/api/login \
  -H 'content-type: application/json' -d '{"password":"dev-password"}'
curl -s -b /tmp/ck 'http://127.0.0.1:8800/api/logs?limit=abc'                       # 200 且不泄露 SQL

# 爆破限速（第 10 次起 429）
for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' -X POST \
  http://127.0.0.1:8800/api/login -H 'content-type: application/json' \
  -H 'cf-connecting-ip: 203.0.113.9' -d '{"password":"wrong"}'; done; echo

# 跨站写请求
curl -s -b /tmp/ck -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8800/api/tasks \
  -H 'content-type: application/json' -H 'Origin: https://evil.example' -d '{}'      # 403
```

## 报告漏洞

开 issue 时请不要贴真实的手机号、session、`api_hash`。
涉及密钥泄露的，请先改 `ADMIN_PASSWORD` / `SESSION_SECRET` 并在 Telegram 里终止该设备的登录。
