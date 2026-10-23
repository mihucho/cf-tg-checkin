/**
 * Worker 入口：
 *  - /api/login、/api/session、/api/logout 在这里处理（Cookie + HMAC 签名）
 *  - 其他 /api/* 需要登录，转发给唯一的 Durable Object（TgAgent）
 *  - 静态管理界面由 Workers Assets 直接服务
 *  - Cron Trigger 只是兜底：正常调度靠 DO alarm
 */
import { TgAgent } from "./agent";
import { BUILD } from "./version";
import type { Env } from "./env";

export { TgAgent };

const COOKIE_NAME = "tg_checkin";
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 状态随时在变，绝对不能让浏览器/边缘缓存住
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function base64url(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function secretOf(env: Env): string | null {
  const secret = env.SESSION_SECRET || env.ADMIN_PASSWORD;
  return secret ? secret : null;
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64url(signature);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const secret = secretOf(env);
  if (!secret) return false;
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return false;
  const [version, expRaw, signature] = token.split(".");
  if (version !== "v1" || !expRaw || !signature) return false;
  const expires = Number(expRaw);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const expected = await sign(secret, `v1.${expires}`);
  return constantTimeEqual(expected, signature);
}

function cookieHeader(value: string, maxAgeSeconds: number): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}; Secure`;
}

/**
 * 拿到唯一的 DO stub。
 *
 * `DO_LOCATION_HINT`（可选）决定 DO 创建在哪个区域，从而决定连 Telegram 的出口区域。
 * 注意：locationHint 只在 **创建时** 生效，已有实例不会被迁移。
 */
function agentStub(env: Env) {
  const id = env.TG_AGENT.idFromName("main");
  const hint = env.DO_LOCATION_HINT?.trim();
  return hint ? env.TG_AGENT.get(id, { locationHint: hint as DurableObjectLocationHint }) : env.TG_AGENT.get(id);
}

async function proxyToAgent(request: Request, env: Env, url: URL): Promise<Response> {
  const doPath = url.pathname.replace(/^\/api/, "");
  const target = `https://agent${doPath}${url.search}`;
  const init: RequestInit = {
    method: request.method,
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
      // 把 Worker 侧的 colo 带给 DO，便于观察「这次运行从哪个机房出去」
      ...(request.cf?.colo ? { "x-cf-colo": String(request.cf.colo) } : {}),
    },
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
  }
  const response = await agentStub(env).fetch(target, init);
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.delete("expires");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const path = url.pathname;

    // 公开：用来确认线上跑的是哪一版（不暴露任何配置）
    if (path === "/api/version") {
      return json({ ...BUILD, worker: "cf-tg-checkin" }, 200, { "cache-control": "no-store" });
    }

    if (path === "/api/session") {
      return json({
        authenticated: await isAuthenticated(request, env),
        needsSetup: !secretOf(env),
      });
    }

    if (path === "/api/login" && request.method === "POST") {
      const secret = secretOf(env);
      if (!secret) {
        return json({ error: "还没有配置 ADMIN_PASSWORD，请先执行 wrangler secret put ADMIN_PASSWORD" }, 500);
      }
      let password = "";
      try {
        password = String(((await request.json()) as { password?: string }).password ?? "");
      } catch {
        return json({ error: "请求格式错误" }, 400);
      }
      if (!password || !constantTimeEqual(password, env.ADMIN_PASSWORD ?? "")) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return json({ error: "密码不正确" }, 401);
      }
      const expires = Date.now() + TOKEN_TTL_MS;
      const signature = await sign(secret, `v1.${expires}`);
      return json(
        { ok: true },
        200,
        { "set-cookie": cookieHeader(`v1.${expires}.${signature}`, Math.floor(TOKEN_TTL_MS / 1000)) },
      );
    }

    if (path === "/api/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
    }

    if (!(await isAuthenticated(request, env))) {
      return json({ error: "未登录", authenticated: false }, 401);
    }

    try {
      return await proxyToAgent(request, env, url);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      agentStub(env)
        .fetch("https://agent/tick", { method: "POST" })
        .catch(() => undefined),
    );
  },
};
