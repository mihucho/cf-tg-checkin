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
| 本地命令行 | `npx wrangler secret put ADMIN_PASSWORD` |
| Cloudflare 控制台 | Worker → **Settings → Variables and Secrets → Add → Secret** |
| 一键部署按钮 | 部署向导里的 Secrets 一步 |
| GitHub Actions | 见上面的 `secrets:` 参数 |

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

## 排查表

| 现象 | 原因 / 处理 |
| --- | --- |
| 页面只显示「需要配置 ADMIN_PASSWORD」 | 还没设 secret，见上面四种方法 |
| 登录报 `API_ID_INVALID` | `apiId` 与 `apiHash` 不配套；回 my.telegram.org 重新复制 |
| 验证码一直「不正确」 | 用最新一次收到的码；超过 10 分钟要重新获取 |
| 任务日志一直是「还没登录 Telegram」 | session 被踢（在别的设备退出登录）→ 账号页重新登录 |
| 收藏夹发指令没反应 | 触发器轮询默认 60 秒；检查设置里的「触发器开关」「控制会话」；看日志页 |
| 点按钮步骤失败 | 机器人可能改版了；日志里会列出当时可点的按钮文本，照着重配 `btn:...` |
| 部署后 404 / 页面白屏 | `public/` 没一起上传；确认 `wrangler.jsonc` 的 `assets.directory` |
| 报 Durable Object 相关错误 | 改过 `migrations` tag 或类名；需要新增 migration 而不是改旧的 |
| 想省钱 | 设置页把「触发轮询间隔」调大（如 300 秒），DO 请求次数会明显下降 |
