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
/** 登录有效期：7 天（无状态 token，登出只清浏览器 Cookie，改密码/密钥才能全端失效） */
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
/** API 请求体上限 */
const MAX_BODY_BYTES = 64 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 状态随时在变，绝对不能让浏览器/边缘缓存住
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
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

/**
 * 登录限速：同一来源失败 10 次 / 10 分钟就锁定（429）。
 * 计数落在 DO 的 SQLite 里，多 colo 一致。
 *
 * mode=peek 只查询是否被封；mode=fail / mode=success 记录结果。
 */
async function authThrottle(
  env: Env,
  ip: string,
  mode: "peek" | "fail" | "success",
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  try {
    const response = await agentStub(env).fetch("https://agent/auth/attempt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ip, mode }),
    });
    const data = (await response.json()) as { allowed?: boolean; retryAfterSeconds?: number };
    return { allowed: data.allowed !== false, retryAfterSeconds: Number(data.retryAfterSeconds ?? 0) };
  } catch {
    // DO 不可用时不要把人锁在门外
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** 状态变更类请求：浏览器跨站发来的（Origin 与本站不一致）直接拒绝 */
function originRejected(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false; // curl / 服务端调用没有 Origin
  try {
    return new URL(origin).host !== url.host;
  } catch {
    return true;
  }
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
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) {
      return json({ error: `请求体过大（上限 ${Math.round(MAX_BODY_BYTES / 1024)} KB）` }, 413);
    }
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) {
      return json({ error: `请求体过大（上限 ${Math.round(MAX_BODY_BYTES / 1024)} KB）` }, 413);
    }
    init.body = body;
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

    // 只允许指定 Host（配置了 ALLOWED_HOSTS 时）：防止绕过 Cloudflare Access 直连 workers.dev
    const allowedHosts = (env.ALLOWED_HOSTS ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (allowedHosts.length && !allowedHosts.includes(url.hostname.toLowerCase())) {
      return json({ error: "该域名不允许访问" }, 403);
    }

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
      // 登录也是状态变更（会下发 Cookie），同样挡掉跨站来源
      if (originRejected(request, url)) return json({ error: "请求来源不被允许" }, 403);

      const secret = secretOf(env);
      if (!secret) {
        return json({ error: "还没有配置 ADMIN_PASSWORD，请先执行 wrangler secret put ADMIN_PASSWORD" }, 500);
      }
      let password = "";
      try {
        const body = (await request.text()).slice(0, 4096);
        password = String((JSON.parse(body) as { password?: string }).password ?? "");
      } catch {
        return json({ error: "请求格式错误" }, 400);
      }

      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const verdict = await authThrottle(env, ip, "peek");
      if (!verdict.allowed) {
        return json(
          { error: `尝试次数过多，请 ${Math.ceil(verdict.retryAfterSeconds / 60)} 分钟后再试` },
          429,
          { "retry-after": String(verdict.retryAfterSeconds) },
        );
      }

      if (!password || !constantTimeEqual(password, env.ADMIN_PASSWORD ?? "")) {
        const after = await authThrottle(env, ip, "fail");
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (!after.allowed) {
          return json(
            { error: `尝试次数过多，请 ${Math.ceil(after.retryAfterSeconds / 60)} 分钟后再试` },
            429,
            { "retry-after": String(after.retryAfterSeconds) },
          );
        }
        return json({ error: "密码不正确" }, 401);
      }
      await authThrottle(env, ip, "success");
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

    // 状态变更类请求的跨站防护（SameSite=Lax 之外再加一层）
    if (request.method !== "GET" && request.method !== "HEAD" && originRejected(request, url)) {
      return json({ error: "请求来源不被允许" }, 403);
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
