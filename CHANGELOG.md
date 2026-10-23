# 更新日志

版本号只在 `package.json` 里维护（构建时注入到产物，页面底部和 `GET /api/version` 都会显示它）。

发版流程：

```bash
npm version patch      # 或 minor / major：改 package.json + 生成 commit 和 tag
git push --follow-tags # 触发部署（Workers Builds / GitHub Actions）
```

## [Unreleased]

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
