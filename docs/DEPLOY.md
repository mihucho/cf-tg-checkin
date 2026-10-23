# 部署指南

仓库：<https://github.com/mihucho/cf-tg-checkin>

四种部署方式，选一个就行。都要准备两样东西：

- **Cloudflare 账号**（免费版够用）
- **Telegram api_id / api_hash**：<https://my.telegram.org> → API development tools

---

## 一张表选方式

| 方式 | 适合谁 | 你需要做的 | 之后怎么更新 |
| --- | --- | --- | --- |
| [① 一键部署按钮](#方式一一键部署deploy-to-cloudflare) | 想 3 分钟用起来 | 点按钮、登录 Cloudflare、填口令 | 在 Cloudflare 里重新部署，或等 Workers Builds 自动构建 |
| [② Workers Builds（连自己的仓库）](#方式二workers-builds连自己的-git-仓库) | 要长期改代码 | 在控制台连 GitHub 仓库 | `git push` 自动构建部署 |
| [③ GitHub Actions](#方式三github-actions) | 想要完整 CI（类型检查 + 单测 + 部署） | 配两个仓库 Secret | `git push` 自动跑测试并部署 |
| [④ 本地 wrangler](#方式四本地-wrangler-命令行) | 想完全掌控 / 本地调试 | 装 Node、`wrangler login` | 本地 `npm run deploy` |

> 四种方式最后跑的都是同一件事：`npm run build`（esbuild 打包成 `dist/worker.mjs`）→ `wrangler deploy`。
> 因为 `wrangler.jsonc` 里配了 `build.command`，所以**单独执行 `wrangler deploy` 也会自动打包**，不会漏构建。

---

## 方式一：一键部署（Deploy to Cloudflare）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mihucho/cf-tg-checkin)

1. 点上面的按钮 → 用 GitHub 登录并授权 Cloudflare（它会把这个仓库 **fork 到你自己的账号**下）
2. 确认 Worker 名字（默认 `cf-tg-checkin`）、仓库名
3. 在 **Secrets** 一步填 `ADMIN_PASSWORD`（这是管理界面的登录口令；
   这个值来自仓库里的 `.dev.vars.example`，Cloudflare 会自动识别并提示填写）
4. 等构建完成 → 点开分配的 `*.workers.dev` 域名

部署完成后如果忘了填口令，见 [下面「补设置口令」](#设置-admin_password-的四种方法)。

---

## 方式二：Workers Builds（连自己的 Git 仓库）

适合「我自己维护这个仓库，push 就上线」。

1. 先把仓库 fork/导入到你自己的 GitHub
2. Cloudflare 控制台 → **Workers & Pages** → **Create** → **Import a repository**
3. 授权 GitHub App，选中仓库
4. 构建配置（Cloudflare 会自动从 `package.json` 读出来，确认一下即可）：
   - **Build command**：`npm run build`
   - **Deploy command**：`npx wrangler deploy`
   - **Root directory**：`/`
5. 创建后进 **Settings → Variables and Secrets** → 添加 Secret `ADMIN_PASSWORD`
6. 之后每次 push 到 `main` 都会自动构建部署

Durable Object（`TgAgent`）会在首次部署时按 `wrangler.jsonc` 的 `migrations` 自动创建，**不需要手动建**。

---

## 方式三：GitHub Actions

仓库自带 [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)：
任何分支/PR 跑 `typecheck + test + build`，`main` 分支额外跑部署。

1. 生成 API Token：Cloudflare 控制台 → **My Profile → API Tokens → Create Token** → 用模板
   **Edit Cloudflare Workers**（需要 `Workers Scripts: Edit` 权限）
2. 拿到 **Account ID**：控制台右侧栏，或 `npx wrangler whoami`
3. 仓库 → **Settings → Secrets and variables → Actions** 添加：
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
4. push 到 `main` 即部署；也可以在 **Actions → Deploy → Run workflow** 手动触发

想让 Actions 顺手把口令也设上，在 workflow 的 `Publish` 步骤里加
[wrangler-action 的 `secrets` 参数](https://github.com/cloudflare/wrangler-action#secrets)：

```yaml
      - name: Publish
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
          secrets: |
            ADMIN_PASSWORD
        env:
          ADMIN_PASSWORD: ${{ secrets.ADMIN_PASSWORD }}
```

---

## 方式四：本地 wrangler 命令行

```bash
git clone https://github.com/mihucho/cf-tg-checkin.git
cd cf-tg-checkin
npm install

npx wrangler login                       # 浏览器授权
npx wrangler secret put ADMIN_PASSWORD   # 管理口令
npm run deploy                           # 打包 + 部署（wrangler 会先跑 build.command）
```

输出里会给你 `https://cf-tg-checkin.<你的子域>.workers.dev`。

---

## 部署后必做 3 步

1. **打开域名**，用 `ADMIN_PASSWORD` 登录
2. **账号页**填 `apiId` / `apiHash` / 手机号（含国家码，如 `+8613800000000`）→ 收验证码 →
   有两步验证的账号会再来一步密码
3. **在 Telegram 收藏夹里**发一条配置，例如：

   ```
   9.30 签到 btn:立即签到 #kw:签到成功|今日已签到
   ```

   一分钟内会收到「已创建任务 #1」的确认（首次还会收到一条语法提示）。

---

## 设置 `ADMIN_PASSWORD` 的四种方法

| 场景 | 命令 / 位置 |
| --- | --- |
| 本地命令行（**最稳**） | `npx wrangler secret put ADMIN_PASSWORD` |
| 一键部署按钮 | 部署向导里的 Secrets 一步 |
| GitHub Actions | 见上面的 `secrets:` 参数 |
| Cloudflare 控制台 | Worker → **Settings → Variables and Secrets → Add → Secret** |

> ⚠️ **别在控制台变量页点「保存并部署 / Save and deploy」**。
> 那一下会重新上传一次脚本，并且**会把当前 Worker 的脚本换掉**（见下面「报错：does not export class 'TgAgent'」）。
> 需要用 `wrangler secret put`，它只更新密钥、不动脚本；实在要在控制台点，也请点 **Secret** 而不是普通变量，
> 并在点之前确认线上版本是本仓库构建出来的。

没有设置口令时，页面会显示「需要配置 ADMIN_PASSWORD」的提示，**任何人都无法登录**（这是故意设计）。
设置完刷新页面即可，不用重新部署。

可选 secret / 变量：

| 名称 | 作用 |
| --- | --- |
| `SESSION_SECRET` | 登录 Cookie 的 HMAC 密钥，不填则复用 `ADMIN_PASSWORD` |
| `TG_API_ID` / `TG_API_HASH` | 把 Telegram 应用凭据放环境变量里，省得在界面填 |

---

## 本地开发

```bash
cp .dev.vars.example .dev.vars    # 填 ADMIN_PASSWORD
npm install
npm run dev                       # = wrangler dev（自定义构建会自动打包并 watch src/）
npm test                          # 调度 + 触发语法 + 按钮解析的单测
npm run typecheck
```

`wrangler dev` 里的 workerd 可以真实连接 Telegram（`cloudflare:sockets` 在本地可用），
所以登录、签到都能在本地完整跑通。

---

## 登录人机验证（Cloudflare Turnstile，可选）

给登录页加一层「我不是机器人」，防住口令爆破之外的撞库/脚本尝试。免费，且不像 reCAPTCHA 那样要额外开关。

1. Cloudflare 控制台 → **Turnstile** → **Add site**
   - 域名填你的 Worker 域名（`cf-tg-checkin.xxx.workers.dev` 或自定义域名都行）
   - Widget Mode 用默认的 **Managed**
2. 拿到两个 key，配到 Worker：

```bash
npx wrangler secret put TURNSTILE_SITE_KEY     # 站点 key（公开，会下发到前端）
npx wrangler secret put TURNSTILE_SECRET_KEY   # 密钥（只在服务端用）
```

3. 刷新登录页 —— 密码框下面会出现验证框；**没配这两个变量时完全不出现**，登录流程和以前一样。

行为细节：

- 只有**两个 key 都配了**才启用（只配一个视为没配，避免把人锁在门外）
- 校验失败直接拒绝登录（400），并计入登录失败次数（10 次/10 分钟锁定照旧）
- 校验服务不可用时 **fail closed**（拒绝登录）。真遇到 Turnstile 故障要应急登录，删掉 `TURNSTILE_SECRET_KEY` 即可
- 校验通过后 cookie 正常下发，7 天有效；定时签到不受影响（不经过 HTTP）

本地联调可以用 Cloudflare 官方测试 key（`.dev.vars`）：

```ini
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA   # 始终通过
# TURNSTILE_SECRET_KEY=2x0000000000000000000000000000000AA # 始终失败，用来测拒绝路径
```

> CSP 已经允许 `https://challenges.cloudflare.com`（脚本 / iframe / 连接），不需要额外改。

## 用 Cloudflare Access 兜一层（可选，强烈建议）

Cloudflare Access 是 Zero Trust 里的"身份感知代理"：请求先经过 Cloudflare 的身份验证
（邮箱一次性验证码 / Google / GitHub / 企业 SSO），通过后才转发到你的 Worker。
也就是说 —— 就算 `ADMIN_PASSWORD` 泄露，攻击者连登录页都打不开。

免费版 50 个用户，个人用足够。步骤：

1. **必须用自定义域名**：Access 只能保护你自己 zone 里的主机名，`*.workers.dev` 不支持
   （先按下一节把自定义域名加上，例如 `checkin.example.com`）
2. Cloudflare 控制台 → **Zero Trust → Access → Applications → Add an application**
   → **Self-hosted**
3. Application domain 填 `checkin.example.com`，路径 `/*`
4. Policy：**Allow**，条件填你自己的邮箱；登录方式选 One-time PIN（最省事）或接 Google/GitHub
5. 保存后用无痕窗口访问，应该先要求验证身份，然后才看到「TG 签到台」的登录页

⚠️ **务必堵住 workers.dev 旁路**：Access 只保护了 `checkin.example.com`，
但同一个 Worker 通常还能通过 `cf-tg-checkin.<你的子域>.workers.dev` 直接访问，等于绕过了 Access。
二选一：

```bash
# 方案 A：关掉 workers.dev 路由（推荐，配合自定义域名）
npx wrangler deploy --var ALLOWED_HOSTS:checkin.example.com

# 方案 B：在 wrangler.jsonc 里彻底禁用
#   "workers_dev": false
```

`ALLOWED_HOSTS` 是逗号分隔的白名单，配置后其它 Host 一律 403。
它同时也是**唯一的 Host 校验**手段，所以别把它设成通配。

Access 只影响 HTTP 管理面；定时签到走 DO alarm，不经过 Access，不受影响。

## 自定义域名

Worker → **Settings → Domains & Routes → Add → Custom Domain**，
填一个在你 Cloudflare 里的域名（如 `checkin.example.com`）即可，证书自动签发。

---

## 升级

- **一键部署**：修改 fork 出来的仓库后会自动构建；想跟随上游就同步 fork
- **Workers Builds / Actions**：`git push` 即可
- **本地**：`git pull && npm install && npm run deploy`

升级不需要额外的数据库迁移：`kv` / `tasks` / `logs` 表用 `CREATE TABLE IF NOT EXISTS` 建，
新增字段对老数据是向后兼容的。

---

## 报错：`does not export class 'TgAgent'`

```
New version of script does not export class 'TgAgent' which is depended on by existing Durable Objects.
Did you forget to include it? If you renamed it, try a rename-class migration.
```

**含义**：你账号里已经存在 `TgAgent` 的 Durable Object（说明之前成功部署过带这个类的版本），
但**这次要上传的脚本里没有这个导出**。workerd 不会允许一个「丢掉已存在 DO 类」的版本上线。

常见触发方式：

| 场景 | 说明 |
| --- | --- |
| 在控制台「变量和密钥」页改了变量后点 **保存并部署** | 这一步会重新上传脚本，把线上版本换成一个不含 `TgAgent` 的产物 |
| 部署了错误的入口 | 例如 `dist/smoke.mjs`（调试用的最小 Worker），而不是 `dist/worker.mjs` |
| 部署了没构建 / 过期的产物 | `dist/` 是生成物且已 gitignore；直接 `wrangler deploy` 会由 `build.command` 自动构建，手动上传旧文件就会踩到 |
| 改了 DO 类名但没加 migration | 需要 `renamed_classes` / `deleted_classes` |

### 恢复步骤（保留已有数据）

```bash
npx wrangler login
npm run deploy                       # 构建 + 自检 + 重新上传带 TgAgent 的正确版本
npx wrangler secret put ADMIN_PASSWORD   # 之后再设口令，不会动脚本
```

`npm run deploy` 里带了一道自检（`scripts/check-bundle.mjs`），
它读 `wrangler.jsonc` 里声明的 DO 类，逐个确认打包产物真的导出了它们，不通过就直接中断：

```
配置文件   wrangler.jsonc
入口产物   dist/worker.mjs  (1357 KiB, gzip 368 KiB)
需要导出   TgAgent
✓ 产物导出检查通过
```

### 想彻底删掉这些 Durable Object

改 `wrangler.jsonc` 的 migrations（会**删除**所有该类的 DO 数据，任务/日志/session 都会没）：

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["TgAgent"] },
  { "tag": "v2", "deleted_classes": ["TgAgent"] }
]
```

改名则用：

```jsonc
{ "tag": "v2", "renamed_classes": [{ "from": "TgAgent", "to": "NewAgent" }] }
```

只想推倒重来最省事的办法是删掉 Worker 再重新部署（`npx wrangler delete --name cf-tg-checkin`）。

---

## 确认线上跑的是哪一版

```bash
curl -s https://cf-tg-checkin.<你的子域>.workers.dev/api/version
# {"version":"0.1.0","commit":"bbc176b","buildId":"2026-10-24T01:51:59Z","worker":"cf-tg-checkin"}
```

登录页底部、主界面页脚和「设置 → 关于」也会显示同样的 `v版本 · commit · 构建时间`。
版本号只在 `package.json` 里维护（`npm version patch` 改它），构建时注入。
排查「改了没生效」时先看这里：如果 commit 不是你刚推的那一个，说明部署没成功
（一键部署 / Workers Builds 看构建日志，CLI 看 `npm run deploy` 的输出）。

---

## 排查表

| 现象 | 原因 / 处理 |
| --- | --- |
| 页面只显示「需要配置 ADMIN_PASSWORD」 | 还没设 secret，用 `wrangler secret put` 设置 |
| `does not export class 'TgAgent'` | 见上面 **[专门小节](#报错does-not-export-class-tgagent)**；一般 `npm run deploy` 重传一次即可 |
| 登录报 `API_ID_INVALID` | `apiId` 与 `apiHash` 不配套；回 my.telegram.org 重新复制 |
| 验证码一直「不正确」 | 用最新一次收到的码；超过 10 分钟要重新获取 |
| 登录报 `PHONE_MIGRATE_5` / `NETWORK_MIGRATE_n` | 账号归属的数据中心不是默认的 DC2。程序会自动切到目标 DC 重试，并记住 DC；如果仍失败，重新点一次「获取验证码」（此时验证码会直接在正确的 DC 上申请） |
| 任务日志一直是「还没登录 Telegram」 | session 被踢（在别的设备退出登录）→ 账号页重新登录 |
| `Could not find the input entity for {"userId":…}` | 数字 id 解析需要 `access_hash`，而它只有"见过"对方才有（我们的连接每次执行都是新建的）。现在的三层兜底：`@username` → 落地在 DO 里的实体缓存 → `getDialogs()` 预热后重试；仍失败就把任务目标改成 `@机器人用户名`，或先在 Telegram 里和它对话一次 |
| 收藏夹发指令没反应 | 触发器轮询默认 60 秒；检查设置里的「触发器开关」「控制会话」；看日志页 |
| 点按钮步骤失败 | 机器人可能改版了；日志里会列出当时可点的按钮文本，照着重配 `btn:...` |
| 部署后 404 / 页面白屏 | `public/` 没一起上传；确认 `wrangler.jsonc` 的 `assets.directory` |
| 报 Durable Object 相关错误 | 改过 `migrations` tag 或类名；需要新增 migration 而不是改旧的 |
| 想省钱 | 设置页把「触发轮询间隔」调大（如 300 秒），DO 请求次数会明显下降 |
