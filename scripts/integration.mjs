#!/usr/bin/env node
/**
 * 端到端集成测试：真的起一个 `wrangler dev`（独立持久化目录 + 独立端口），
 * 然后用 HTTP 打完整的 Worker → Durable Object → SQLite 链路。
 *
 * 单测（npm test）覆盖纯函数；这里覆盖单测碰不到的东西：
 * 路由、登录/Cookie、Origin 校验、DO 内嵌 SQLite 的建表/迁移/去重/分页、内部接口隔离。
 *
 * 用法：node scripts/integration.mjs [--verbose]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const verbose = process.argv.includes("--verbose");
const PORT = 8700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "it-password-9f3a";
const persistDir = mkdtempSync(join(tmpdir(), "cf-tg-it-"));

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    if (verbose) console.log(`  ✓ ${name}`);
    return;
  }
  failures.push(`${name}${detail ? `\n    ${detail}` : ""}`);
  console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ""}`);
}

async function main() {
  console.log(`集成测试：起 wrangler dev（端口 ${PORT}，持久化 ${persistDir}）`);
  const wranglerBin = join(process.cwd(), "node_modules", ".bin", "wrangler");
  if (!existsSync(wranglerBin)) throw new Error("找不到 wrangler，先跑 npm install");
  const child = spawn(
    wranglerBin,
    [
      "dev",
      "--port",
      String(PORT),
      "--ip",
      "127.0.0.1",
      "--var",
      `ADMIN_PASSWORD:${PASSWORD}`,
      "--persist-to",
      persistDir,
    ],
    {
      stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      // 独立进程组：wrangler 会再拉 workerd / esbuild，按组 kill 才不会留孤儿进程
      detached: true,
    },
  );

  const logs = [];
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      process.kill(-child.pid, "SIGKILL"); // 整组（wrangler + workerd + esbuild）
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  process.on("exit", stop);

  // 看门狗：卡住就杀掉并报错，绝不无限等
  const watchdog = setTimeout(() => {
    console.error("\n✗ 集成测试超时（180s），已中止");
    console.error(logs.join("").slice(-2000));
    stop();
    process.exit(1);
  }, 180_000);
  watchdog.unref();

  try {
    await waitForServer(logs, stop);

    // ---------- 未登录 ----------
    let res = await fetch(`${BASE}/api/state`);
    check("未登录访问 /api/state 返回 401", res.status === 401, `status=${res.status}`);

    res = await fetch(`${BASE}/api/auth/turnstile`);
    check("未登录时内部接口返回 401（先过登录）", res.status === 401, `status=${res.status}`);

    // ---------- 登录 ----------
    res = await post("/api/login", { password: "wrong" });
    check("错误口令返回 401", res.status === 401, `status=${res.status}`);

    res = await post("/api/login", { password: PASSWORD });
    const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
    check("登录成功并下发 Cookie", res.status === 200 && cookie.startsWith("tg_checkin=v1."), `cookie=${cookie.slice(0, 12)}…`);
    check("Cookie 带 HttpOnly + SameSite=Lax + Secure", /HttpOnly/i.test(res.headers.get("set-cookie") || "") && /SameSite=Lax/i.test(res.headers.get("set-cookie") || "") && /Secure/i.test(res.headers.get("set-cookie") || ""));

    res = await request("GET", "/api/auth/turnstile");
    check("已登录也无法读到 Turnstile secret（403）", res.status === 403, `status=${res.status}`);

    // ---------- Origin 校验 ----------
    res = await post("/api/tasks", { name: "x" }, { origin: "https://evil.example" });
    check("跨站 Origin 的写请求被拒（403）", res.status === 403, `status=${res.status}`);

    // ---------- 初始状态 ----------
    const state = await get("/api/state");
    check("/api/state 返回 settings / tasks / events", !!state.settings && Array.isArray(state.tasks) && !!state.events);
    check("/api/state 不下发 Turnstile secret", state.settings.turnstileSecretKey === "" && "turnstileSecretConfigured" in state.settings);
    check("/api/state 趋势为 7 天", Array.isArray(state.events.trend) && state.events.trend.length === 7);

    // ---------- 建任务 / 去重 / 多目标指纹 ----------
    const taskA = {
      name: "集成-多目标",
      enabled: true,
      target: { kind: "user", id: "a_bot", username: "a_bot" },
      targets: [
        { kind: "user", id: "a_bot", username: "a_bot" },
        { kind: "user", id: "b_bot", username: "b_bot" },
      ],
      schedule: { kind: "daily", time: "08:15" },
      steps: [{ type: "text", text: "签到" }],
      successKeywords: [],
      timeoutSeconds: 30,
      stepDelaySeconds: 3,
      deleteAfterSeconds: 0,
      cleanupPrevious: true,
      source: "ui",
    };
    const created = await post("/api/tasks", taskA);
    const task = created.task;
    check("创建多目标任务", created.status === 200 && Array.isArray(task?.targets) && task.targets.length === 2, `status=${created.status}`);
    check("主目标仍是第一个", task?.target?.username === "a_bot");

    const dup = await post("/api/tasks", taskA);
    check("完全相同的任务被去重（409）", dup.status === 409, `status=${dup.status}`);

    const other = {
      ...taskA,
      targets: [taskA.targets[0], { kind: "user", id: "c_bot", username: "c_bot" }],
    };
    const second = await post("/api/tasks", other);
    check("附加目标不同 → 不算重复，能建第二个", second.status === 200 && second.task.id !== task.id, `status=${second.status}`);

    // ---------- 编辑不丢字段 ----------
    const patched = await request("PATCH", `/api/tasks/${task.id}`, { enabled: false });
    check(
      "只改 enabled 不会丢目标/步骤",
      patched.task?.enabled === false && patched.task?.targets?.length === 2 && patched.task?.steps?.[0]?.text === "签到",
      JSON.stringify({ enabled: patched.task?.enabled, targets: patched.task?.targets?.length }),
    );
    await request("PATCH", `/api/tasks/${task.id}`, { enabled: true });

    // ---------- 指令往返 ----------
    const command = await get(`/api/tasks/${task.id}/command`);
    check("任务可导出为指令", typeof command.command === "string" && command.command.includes("到:@a_bot|@b_bot"), command.command);
    const parsed = await post("/api/trigger/parse", { text: command.command });
    check(
      "指令解析回等价任务",
      parsed.ok === true && parsed.task?.targets?.length === 2 && parsed.task?.steps?.[0]?.text === "签到",
      JSON.stringify(parsed.task?.steps),
    );

    // ---------- 导出 / 导入 ----------
    const exported = await get("/api/tasks/export");
    check("导出包含全部任务且不含运行态字段", exported.tasks.length >= 2 && !("id" in exported.tasks[0]) && !("nextRunAt" in exported.tasks[0]));
    const imported = await post("/api/tasks/import", { tasks: exported.tasks });
    check("原样导入全部跳过", imported.created === 0 && imported.skipped.length === exported.tasks.length, JSON.stringify(imported.skipped?.[0]));

    // ---------- 设置 / 模板 ----------
    const saved = await post("/api/settings", { templates: [{ id: "t1", name: "集成模板", command: "tg 09:30 @a_bot 签到" }] });
    check("自定义模板写入设置", saved.settings?.templates?.[0]?.name === "集成模板");
    const state2 = await get("/api/state");
    check("模板在 /api/state 里可见", state2.settings?.templates?.length === 1);

    // ---------- Webhook 渠道 ----------
    const hookSaved = await post("/api/settings", {
      notifyWebhook: "https://oapi.dingtalk.com/robot/send?access_token=abc",
      notifyWebhookKind: "dingtalk",
      notifyWebhookSecret: "SECit123456",
    });
    check("Webhook 渠道可保存", hookSaved.settings?.notifyWebhookKind === "dingtalk", `got ${hookSaved.settings?.notifyWebhookKind}`);
    check(
      "Webhook 加签密钥不回传、只给已配置标记",
      hookSaved.settings?.notifyWebhookSecret === "" && hookSaved.settings?.notifyWebhookSecretConfigured === true,
    );
    const badKind = await post("/api/settings", { notifyWebhookKind: "hacker" });
    check("非法渠道被忽略（保留原值）", badKind.settings?.notifyWebhookKind === "dingtalk", `got ${badKind.settings?.notifyWebhookKind}`);
    // ---------- 固定渠道：只填 token ----------
    const tokenSaved = await post("/api/settings", {
      notifyWebhookKind: "dingtalk",
      notifyWebhookToken: "integration-token-1",
    });
    check(
      "只填 token 就按渠道生成固定地址",
      tokenSaved.settings?.notifyWebhook === "https://oapi.dingtalk.com/robot/send?access_token=integration-token-1",
      tokenSaved.settings?.notifyWebhook,
    );
    const fullUrlInToken = await post("/api/settings", {
      notifyWebhookKind: "wecom",
      notifyWebhookToken: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-9",
    });
    check(
      "token 框里粘整条地址也能认（会重新按渠道拼）",
      fullUrlInToken.settings?.notifyWebhook === "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-9",
      fullUrlInToken.settings?.notifyWebhook,
    );
    const cleared = await post("/api/settings", { clearNotifyWebhookSecret: true });
    check("可清除加签密钥", cleared.settings?.notifyWebhookSecretConfigured === false);

    // ---------- 通知类型 / 日报 ----------
    const stateNotify = await get("/api/state");
    check(
      "通知类型目录由服务端下发（11 种）",
      Array.isArray(stateNotify.notifyCatalog) && stateNotify.notifyCatalog.length === 11,
      `got ${stateNotify.notifyCatalog?.length}`,
    );
    const picked = await post("/api/settings", { notifyEvents: ["run_failed", "daily_digest", "hack"], digestHour: 7 });
    check(
      "通知类型只保留认识的（hack 被丢弃）",
      JSON.stringify(picked.settings?.notifyEvents) === JSON.stringify(["run_failed", "daily_digest"]),
      JSON.stringify(picked.settings?.notifyEvents),
    );
    check("日报时间可保存", picked.settings?.digestHour === 7, `got ${picked.settings?.digestHour}`);
    const weekly = await post("/api/settings", { digestWeekday: 5, weeklyHour: 9 });
    check(
      "周报的星期/时间独立保存",
      weekly.settings?.digestWeekday === 5 && weekly.settings?.weeklyHour === 9,
      JSON.stringify({ day: weekly.settings?.digestWeekday, hour: weekly.settings?.weeklyHour }),
    );
    const badHour = await post("/api/settings", { digestHour: 99 });
    check("日报时间越界收敛到 23", badHour.settings?.digestHour === 23, `got ${badHour.settings?.digestHour}`);
    await post("/api/settings", { digestHour: 7 });

    // ---------- 通知测试 ----------
    // 先清空 webhook，保证这里是「未配置」分支（前面 Webhook 渠道那节配过地址）
    await post("/api/settings", { notifyWebhook: "" });
    const tested = await post("/api/notify/test", {});
    check(
      "通知测试返回两个通道的结果",
      tested.result && typeof tested.result.telegram?.ok === "boolean" && typeof tested.result.webhook?.ok === "boolean",
      JSON.stringify(tested.result),
    );
    check(
      "没配 Webhook 时明确说明（而不是静默成功）",
      tested.result?.webhook?.ok === false && /Webhook 地址/.test(String(tested.result?.webhook?.error ?? "")),
      JSON.stringify(tested.result?.webhook),
    );
    check(
      "未登录 Telegram 时说明原因（跳过而不是失败）",
      tested.result?.telegram?.ok === false && tested.result?.telegram?.skipped === true,
      JSON.stringify(tested.result?.telegram),
    );
    // overlay：用表单里的值测（指向本地未监听端口，快速失败且不碰外网）
    const overlayTest = await post("/api/notify/test", {
      notifyWebhook: "http://127.0.0.1:9/nowhere",
      notifyWebhookKind: "feishu",
    });
    check(
      "测试用表单里传的值（不用先保存）",
      overlayTest.result?.webhook?.kind === "feishu",
      JSON.stringify(overlayTest.result?.webhook),
    );
    const stateAfterTest = await get("/api/state");
    check(
      "测试不会写入设置",
      (stateAfterTest.settings?.notifyWebhook ?? "") === "",
      `保存的地址变成 ${stateAfterTest.settings?.notifyWebhook}`,
    );

    // ---------- 事件白名单 ----------
    const badEvent = await post("/api/events", { name: "hack" });
    check("未知事件被拒（400）", badEvent.status === 400, `status=${badEvent.status}`);
    const okEvent = await post("/api/events", { name: "failure_handled" });
    check("白名单事件被接受", okEvent.status === 200);
    const state3 = await get("/api/state");
    check("事件计数自增", state3.events.failureHandled >= 1, `got ${state3.events.failureHandled}`);

    // ---------- 日志 ----------
    const logsRes = await get("/api/logs?pageSize=5&sinceHours=24");
    check("/api/logs 分页字段完整", typeof logsRes.total === "number" && Array.isArray(logsRes.logs) && logsRes.pageSize === 5);

    // ---------- run-all 分批 ----------
    const batch = await post("/api/tasks/run-all?offset=0&limit=1");
    check(
      "run-all 分批返回 nextOffset/remaining",
      typeof batch.nextOffset === "number" && typeof batch.remaining === "number" && batch.processed <= 1,
      JSON.stringify({ processed: batch.processed, remaining: batch.remaining, nextOffset: batch.nextOffset }),
    );

    // ---------- 删除 ----------
    const del = await request("DELETE", `/api/tasks/${task.id}`);
    check("删除任务成功", del.status === 200);
    const state4 = await get("/api/state");
    check("删除后不再出现在列表里", !state4.tasks.some((item) => item.id === task.id));

    // ---------- 安全头 ----------
    res = await fetch(`${BASE}/api/version`);
    check("API 响应带 no-store 与 HSTS", res.headers.get("cache-control") === "no-store" && !!res.headers.get("strict-transport-security"));

    // ---------- 登出 ----------
    res = await post("/api/logout", {});
    check("登出返回 200", res.status === 200);
  } finally {
    stop();
    rmSync(persistDir, { recursive: true, force: true });
  }

  clearTimeout(watchdog);
  console.log(`\n${failures.length ? "✗" : "✓"} ${passed} 项通过${failures.length ? ` / ${failures.length} 项失败` : ""}`);
  if (failures.length) {
    console.log(failures.map((item) => `  · ${item}`).join("\n"));
    process.exit(1);
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ 工具 */

let cookieJar = "";

async function request(method, path, body, extraHeaders = {}) {
  const headers = { accept: "application/json", ...(extraHeaders.origin ? { origin: extraHeaders.origin } : {}) };
  if (cookieJar) headers.cookie = cookieJar;
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    // 登录请求不带 Origin，模拟 curl；其他写请求也默认不带（等价同源脚本）
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookieJar = setCookie.split(";")[0];
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return {
    status: res.status,
    headers: res.headers,
    ...(data && typeof data === "object" ? data : {}),
    _raw: data,
  };
}

async function get(path) {
  return request("GET", path);
}

async function post(path, body, extraHeaders = {}) {
  return request("POST", path, body, extraHeaders);
}

async function waitForServer(logs, stop) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/version`);
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  stop();
  throw new Error(`wrangler dev 没能在 90s 内启动：\n${logs.join("").slice(-2000)}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
