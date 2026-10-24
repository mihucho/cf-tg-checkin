# 代码 / 安全 / 产品一致性审计（v0.10.0）

审计对象：`cf-tg-checkin` @ `1b3dfa5`（v0.10.0，11472 行：src 4.6k / public 4.8k / tests 1.3k）
方法：全量阅读核心模块 + 边界用例实证（HTTP 打真实 dev server、单元级往返测试）+ 无头浏览器实测
产出：26 项发现（P0 ×2、P1 ×5、P2 ×8、P3 ×11），本次**已修 9 项**（v0.10.1）

---

## 0. 结论摘要

| 维度 | 评价 | 说明 |
| --- | --- | --- |
| MTProto / Workers 适配 | 好 | socket / transport / 连接复用、DC 迁移、实体三层兜底都经得起推敲 |
| 安全 | 良好 | 口令+HMAC、DO 内限速、Origin 校验、CSP、secret 脱敏；1 处 secret 过度暴露（已修） |
| 数据正确性 | **有硬伤** | 多目标任务首次执行会顶掉主目标；任务指纹漏了附加目标（两处已修） |
| 指令互转 | **有硬伤** | `taskToCommand` 对 9 类内容不可往返（已修） |
| 前端健壮性 | 好 | 零 innerHTML 注入点、无重复 id、表单全部有可访问名 |
| 测试 | 偏窄 | 90 例全在纯函数层；`agent.ts`/`db.ts`/`executor.ts`/`socket.ts` 无回归网 |

---

## 1. P0：数据会被改错（已修）

### P0-1 多目标任务首次执行会把主目标换成第二个目标

**证据**：`src/agent.ts:1621` 的执行循环对每个目标调用 `ensureTarget(client, { ...task, target })`，
而 `ensureTarget` 内部无条件 `store.updateTask(task.id, { target: patch })`。
补全条件 `!username || !accessHash || !title` 对新建的附加目标恒为真，于是：

- `tasks.target` 被第 2 个目标覆盖，`targets` 数组顺序错乱
- 任务名还会按第 2 个目标执行 `renameForTarget`（例如「签到 → @b_bot」）

**影响**：多目标任务第一次运行后配置即被污染，后续所有执行目标错误。
**修复**：新增纯函数 `applyTargetPatch(task, index, patch)`（`src/task.ts`）：
只有主目标能写 `target` 与改名，其余写回 `targets[i]`；`ensureTarget` 改为按索引取目标。
**回归测试**：`tests/tmp-audit4.test.ts`（补全附加目标不改主目标/不改名）。

### P0-2 任务指纹漏掉附加目标，第二个任务建不出来

**证据**：`taskFingerprint` 只算主目标 → `到:@a|@b` 与 `到:@a|@c` 指纹相同，
`findDuplicateTask` 判定重复并直接返回旧任务。
实测：`POST /api/tasks`（B 与 A 仅附加目标不同）→ 返回 `id: 13`（A 的 id），B 蒸发。

**修复**：指纹纳入 `targets`（每个目标带 `#话题` 区分）；实测改为返回新任务 `id: 14`。

---

## 2. P1：功能承诺兑现不了（已修）

### P1-1 `taskToCommand` 生成 9 类"不可往返"的指令

逐条实证（`tests/tmp-audit3.test.ts`，14 个用例，修复前 9 项失败）：

| 内容 | 修复前输出 | 回解结果 |
| --- | --- | --- |
| 文本 `#kw:签到成功` | `#kw:签到成功` | 变成关键词，步骤消失 |
| 文本 `btn:签到` | `btn:签到` | 变成按钮步骤 |
| 文本 `到:@someone` | `到:@someone` | 变成目标 |
| 文本 `9点半` / `09:30` | 原样 | 变成调度时间 |
| 文本 `列表` | 原样 | 变成管理命令 |
| 文本 `https://t.me/x` | 原样 | 变成目标 |
| `rand:早上 好\|午安` | 未加引号 | 被空格切开 |
| `#kw:签到 成功` | 未加引号 | 关键词被截断 |
| 名称/文本含 `"` | 引号被吞或吃掉 `"` | 内容丢字符 |

**修复**（`src/schedule/command.ts` + `src/schedule/dsl.ts`）：
- `needsSayPrefix()`：9 类前缀命中时用 `say:` 显式声明"这是文本"
- `quoteIfNeeded()`：空格 / `|` / `,` / `"` / `\` 全部加引号，内部 `"` 与 `\` 做反斜杠转义
- `tokenize()` 支持 `\"`、`\\` 转义（原来引号只能整体包裹，内容里无法出现引号）
- `rand:` 选项、`#kw:` 关键词逐项加引号

HTTP 端到端复核：

```
导出 tg 09:30 @a_bot say:#kw:假的 say:9点半 rand:"早上 好"|午安 #kw:"签到 成功" #name:转义测试
回解 steps=[text:#kw:假的, text:9点半, random[早上 好, 午安]] kw=[签到 成功] ✓
```

### P1-2 `/auth/turnstile` 把 Turnstile secret 回给任何已登录请求

**证据**：`src/agent.ts` 的 `/auth/turnstile` 返回 `secretKey`；Worker 的 `/api/*` 代理要求登录，
所以任意一个已登录会话 `GET /api/auth/turnstile` 就能读到 secret —— 与 README/SECURITY 的
「Secret 只存服务端、不回传」直接矛盾，也扩大了 secret 的暴露面（浏览器、日志、代理）。

**修复**：该接口要求 `x-internal-call: turnstile` 头。`proxyToAgent` 会重建请求头（只带
`content-type` / `x-cf-colo`），外部无法注入 → 只有 Worker 内部能调。实测外部调用返回
`{"error":"仅限内部调用"}`，登录页 `siteKey` 仍正常下发。

### P1-3 非数组入参 500 并泄露内部错误文本

**证据**：`normalizeTaskInput` 里 `(input.steps ?? []).slice` 对字符串入参抛
`TypeError: (s.steps ?? []).slice(...).map is not a function`，
`publicError()` 只过滤 `SQLITE|constraint` 等关键词，于是原始 JS 报错直接返回给客户端。

**修复**：`steps` / `targets` / `successKeywords` / `options` 全部 `Array.isArray` 兜底；实测转为正常 200。

### P1-4 `db.updateTask` 不写 `last_detail`

**证据**：`UPDATE tasks SET ... last_message = ? ...` 缺 `last_detail`，而 `merged.lastDetail` 存在于内存对象。
`ensureTarget` 补全目标时走 `updateTask`，于是"最近一次详情"停留在旧值（前端详情弹窗会显示上一次的步骤日志）。

**修复**：补 `last_detail = ?` 绑定。

### P1-5 删除任务留下 KV 垃圾

**证据**：`deleteTask` 只删 `task:${id}:sent`，多目标引入的 `task:${id}:sent:<target>`
与 `notify:${id}:at` 永久残留。

**修复**：`DELETE FROM kv WHERE key LIKE 'task:{id}:sent:%'` + 删 `notify:{id}:at`。

---

## 3. P2：待排期（其中 P2-1 ~ P2-7 已在 v0.11.0 修掉，见文末「第二轮」）

| # | 问题 | 位置 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| P2-1 | `pollTriggers` 只取最近 20 条，新消息超过 20 条时游标直接跳到最高 id | `agent.ts:993` | 静默丢指令（可能是"我明明发了却没反应"的真正原因之一） | 取 100 条，或按游标循环拉到追平 |
| P2-2 | `clickWithTeleprotoHelper` 有恒为 false 的死代码 `index === button.row === undefined` | `executor.ts:396` | 兜底点击的行匹配实际失效 | 改成 `flat[index]` 按 `row*列数+column` 取 |
| P2-3 | socket `waitFor` 只有单个 `wake` 槽；`connect` 超时不关底层 socket；`close()` 不 `cancel()` reader | `socket.ts:90/141/169` | 并发读会有一方永久挂起；超时可能泄漏连接 | 改 `Set<resolver>`；超时 `handle.close()`；close 时 `reader.cancel()` |
| P2-4 | 执行器没有"整任务时间预算"：N 目标 × M 步骤 × 单步 30s 可远超一次 alarm 的实际可用时间 | `executor.ts:466+` | 大任务跑到一半被驱逐，日志显示成功但后续目标没跑 | 加 `deadline = start + budget`，每步检查并提前收尾 |
| P2-5 | `POST /tasks/run-all` 同步跑完所有任务再返回 | `agent.ts:1537` | 任务多时浏览器/网关 100s 超时（524），前端以为失败 | 改成"排队 + 立即返回"，前端看日志推进 |
| P2-6 | `countEvent` 每类只留 5000 条 | `db.ts:513` | 「设置 → 关于」里的执行次数会静默封顶在 5000 | 用累加计数器（kv）另存总数 |
| P2-7 | `withClient` 对**任何**错误都重连并重跑一次 | `agent.ts:599` | 非连接类错误会重放副作用（依赖指纹去重兜底） | 只对 `disconnect/socket/timeout` 等错误重试 |
| P2-8 | `dueTasks` 每次只取 5 个 | `db.ts:408` | 任务多且同时到点时，要分多轮 5s 才跑完 | 文档写明，或按剩余时间动态放宽 |

## 3.5 第二轮修复（v0.11.0）

| # | 修复方式 | 回归测试 |
| --- | --- | --- |
| P2-1 | `pollTriggers` 改成按批回溯（100 条 × 最多 5 批）+ 按 id 去重，不再"游标一跳、中间指令全丢" | — |
| P2-2 | `clickWithTeleprotoHelper` 去掉恒假条件，改为 `grid[row][column]` 定位 | — |
| P2-3 | socket：等待者改 `Set`（多读者都能被唤醒）、连接超时主动 `handle.close()`、`close()` 里 `reader.cancel()` | `tests/socket.test.ts`（4 例 ByteQueue） |
| P2-4 | 新增 `taskBudgetMs()`：按步骤类型估算整任务预算（30s ~ 4min），超预算就停止后续步骤并记「超出时间预算」 | `tests/budget.test.ts`（3 例） |
| P2-5 | `POST /tasks/run-all` 支持 `offset`/`limit` 分批，返回 `nextOffset`/`remaining`；前端按 offset 循环推进 | 实测两批 8 + 2 跑完 10 个任务 |
| P2-6 | `recordEvent` 另存 `event:total:<name>` 累计计数，`countEvent` 优先读它（老部署首次读时用现有条数初始化，数字不会掉） | 实测历史 2 条 + 3 次自增 = 4 |
| P2-7 | 新增 `isConnectionError()`，`withClient` 只对连接层错误重连重跑，业务错误不再重放副作用 | `tests/budget.test.ts`（12 个正反例） |
| P2-8 | `dueTasks` 每次上限 5 → 20 | — |
| P3-1 | `buildState()` 去掉多余的 `async`；7 天趋势加 60 秒缓存（`cache:usageTrend`） | — |
| P3-5 | API 响应补 `Strict-Transport-Security` | 实测响应头存在 |

## 4. P3：工程与文档

1. `buildState` 标了 `async` 但没有 `await`；且每次 `/api/state` 重算 7 天趋势（`listEventSamples` 全取）——建议缓存 60s。
2. `/api/state` 里带 50 条日志且含 `detail` 原文，当前 15 KB 可控，但步骤日志变长后会膨胀。
3. 无 lint / format（ESLint 或 Biome）+ CI 无格式检查，风格靠人肉；`build.mjs` 有死变量 `spec` + `void spec`。
4. 纯 http 自建站点登不上（Cookie 恒带 `Secure`），需在 DEPLOY 文档写明"必须 HTTPS"。
5. API 响应无 `Strict-Transport-Security`（静态资源有 CSP，但没有 HSTS）。
6. 时区只支持固定偏移，无 DST（欧美用户夏令时会偏 1 小时）——已知限制，建议在设置页提示。
7. `/tasks/:id/logs` 不支持 `sinceHours`，与 `/logs` 不一致。
8. `#kw:` / `rand:` 里的 `|` 是语法分隔符，无法表达（当前降级为空格）——已在 `command.ts` 注释说明。
9. 指令导出会丢失 `accessHash` / `kind`（只剩 `@username` / 数字 id）——文档里应写明"指令是便携表示，不是完整备份，完整备份用导出 JSON"。
10. 测试覆盖：`agent.ts`（1976 行）、`db.ts`、`executor.ts`、`socket.ts` 零测试。建议补 3 类：Miniflare 跑 DO + 内嵌 SQLite 的集成测试、executor 的按钮/等待状态机（用假 client）、socket 的字节队列单测。
11. 文档一致性：`docs/UI_COPY.md` 未收录新增的 `say:` 与 `#话题` 之外的转义规则；`API.md` 未写 `/auth/*` 是内部接口。

---

## 5. 做得好的地方（复核通过，无需改动）

- **CSRF**：状态变更接口校验 `Origin`，登录也校验；Cookie `HttpOnly + SameSite=Lax + Secure`。
- **限速**：失败计数落在 DO SQLite（多 colo 一致），10 次/10 分钟锁定；DO 不可用时 "fail open" 有注释说明权衡。
- **secret 处理**：`redactSettings()` 把 Turnstile secret 换成布尔标记；`/api/state` 不含 session / apiHash。
- **前端 XSS**：`el()` 只支持 `html` 属性但全仓 0 处使用；日志/任务名/机器人回包一律走 textNode。
- **可访问性**：5 个页面 0 个无标签输入框、0 个空按钮、0 个重复 id；弹窗有 `role="dialog"` + `aria-modal` + 焦点归还。
- **安全头**：`public/_headers` 带完整 CSP（`default-src 'self'`、`frame-ancestors 'none'`）、nosniff、Permissions-Policy。
- **缓存陷阱**：`/api/*` 全部 `no-store`（这是曾经踩过的坑，现在有系统性防护）。
- **产物校验**：`check-bundle.mjs` 挡住"没有导出 TgAgent"这类线上事故，CI 也会跑。
- **错误转译**：`publicError()` 拦截 SQLite/驱动错误，不把实现细节抛给前端（仅 P1-3 的漏网已修）。
