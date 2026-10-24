/**
 * TgAgent —— 唯一的 Durable Object，负责：
 *  1. 持有 Telegram session（StringSession 存在 DO 内嵌 SQLite）
 *  2. 用 DO alarm 做调度（每个 alarm 重连一次，做完就断开，避免长时间占着 socket）
 *  3. 轮询控制会话里的触发消息（收藏夹发 `9.30 签到` 即可建任务）
 *  4. 执行签到动作（发消息 / 点按钮 / 判定成功）
 *  5. 给管理界面提供 JSON API
 */
import { Api } from "teleproto";
import { password as PasswordModule } from "teleproto";
import type { TelegramClient } from "teleproto";
import { Store } from "./db";
import type { AccountInfo, AgentState, LogEntry, Settings, Target, Task, TaskInput } from "./types";
import { createTgClient, createTgClientOnDc, errorMessage, migrateDcFromError } from "./telegram/client";
import { executeTask, resolveEntity, type ExecHooks } from "./telegram/executor";
import { computeNextRun, formatInTimezone, isSameLocalDay } from "./schedule/time";
import {
  defaultName,
  findTimeToken,
  parseTrigger,
  renameForTarget,
  tokenize,
  type TriggerContext,
} from "./schedule/dsl";
import { messageTargetHint, usernameFromLink, type MessageLike, type MessageTargetHint } from "./telegram/targets";
import type { Env } from "./env";

interface Credentials {
  apiId: number | null;
  apiHash: string;
}

interface PendingLogin {
  apiId: number;
  apiHash: string;
  phone: string;
  phoneCodeHash: string;
  session: string;
  stage: "code" | "password";
  at: number;
}

const KV_SESSION = "account:session";
const KV_ME = "account:me";
const KV_CREDS = "account:creds";
const KV_PENDING = "account:pending";
const KV_PHONE = "account:phone";
const KV_LAST_ERROR = "account:lastError";
/** 控制会话里最近一次"转发/回复过来的目标"（先转发机器人、再单独发配置时用） */
const KV_TRIGGER_TARGET = "trigger:target";
/**
 * 实体缓存（[markedId, accessHash, username, phone, name]）。
 * teleproto 把这份缓存放在 session 对象里，StringSession.save() 不会带上它，
 * 而我们的 client 每次执行都是新建的 —— 不落地的话数字 id 永远解析不出来。
 */
const KV_ENTITIES = "entities:cache";
/**
 * 连接复用窗口（毫秒）。
 *
 * DO 里的长连接是可行的（Cloudflare 2026 起，活跃的 outbound 连接会阻止驱逐，
 * 单连接上限 15 分钟），但会被部署/迁移/驱逐随时打断，所以不当成可用性前提。
 * 这里只做「短时间内复用」：连着点几个任务、或一次 tick 里跑多个任务时不必反复重连；
 * 空闲超过这个时间就主动断开，省得白占 DO 常驻时长。
 *
 * 设成 0 表示每次操作都新建连接。
 */
const CLIENT_IDLE_REUSE_MS = 30_000;

const REPLY_MARKERS = ["✅", "❌", "⚠️", "📋", "💡", "⚙️", "🔧", "📝", "🚀", "⏰", "🗑️"];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function jsonError(error: unknown, status = 400): Response {
  return json({ error: publicError(error) }, status);
}

/** 把内部错误翻译成对外可读、且不泄露实现细节的信息 */
function publicError(error: unknown): string {
  const message = errorMessage(error);
  // 数据库/驱动层错误不外泄（例如 "datatype mismatch: SQLITE_MISMATCH"）
  if (/SQLITE|datatype|constraint|no such (table|column)/i.test(message)) {
    return "请求参数不合法";
  }
  return message;
}

/** query/body 里的数字参数：非数字一律回落到默认值，避免把 "abc" 塞进 SQL */
function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function isOwnReply(text: string): boolean {
  const trimmed = text.trimStart();
  return REPLY_MARKERS.some((marker) => trimmed.startsWith(marker));
}

export class TgAgent implements DurableObject {
  private readonly store: Store;
  private queue: Promise<unknown> = Promise.resolve();
  /** 复用的 client（见 CLIENT_IDLE_REUSE_MS） */
  private cachedClient: TelegramClient | null = null;
  private cachedClientKey: string | null = null;
  private cachedClientTouchedAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前是否真的有活跃的 MTProto 连接（内存态，驱逐后自然为 false） */
  private connected = false;
  /** 正在进行的 withClient 操作数：空闲计时器不能在这时候掐连接 */
  private activeOps = 0;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.store = new Store(ctx.storage.sql);
  }

  /** 串行化所有会改状态的操作（DO 里仍可能并发交错 await） */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      const colo = request.headers.get("x-cf-colo");
      if (colo && this.store.getKv("runtime:colo") !== colo) this.store.setKv("runtime:colo", colo);
      if (path === "/state" && method === "GET") return json(await this.buildState());
      if (path === "/settings" && method === "POST") {
        const body = (await request.json()) as Partial<Settings> & { clearTurnstileSecret?: boolean };
        const { clearTurnstileSecret, ...rest } = body;
        const patch: Partial<Settings> = { ...rest };
        if (clearTurnstileSecret) patch.turnstileSecretKey = "";
        const before = this.store.getSettings();
        const saved = this.store.saveSettings(sanitizeSettings(patch));
        if (clearTurnstileSecret) this.store.saveSettings({ turnstileSecretKey: "" });
        if (before.controlChat !== saved.controlChat) this.resetTriggerCursor();
        if (before.triggerEnabled !== saved.triggerEnabled) await this.scheduleNextAlarm();
        return json({ settings: redactSettings(this.store.getSettings()) });
      }

      if (path === "/tasks" && method === "POST") {
        const body = (await request.json()) as TaskInput;
        const { task, created } = this.createTask(body);
        if (!created) return json({ task, error: `已存在相同任务 #${task.id}` }, 409);
        await this.scheduleNextAlarm();
        return json({ task });
      }
      if (path === "/tasks/run-all" && method === "POST") {
        const logs = await this.serialize(() => this.runAllTasks());
        await this.scheduleNextAlarm();
        return json({ ok: logs.every((log) => log.ok), logs });
      }

      const taskMatch = /^\/tasks\/(\d+)(\/run|\/logs)?$/.exec(path);
      if (taskMatch) {
        const id = Number(taskMatch[1]);
        const suffix = taskMatch[2];
        const task = this.store.getTask(id);
        if (!task) return jsonError("任务不存在", 404);

        if (suffix === "/run" && method === "POST") {
          const log = await this.serialize(() => this.runTasks([task], undefined, { manual: true }));
          await this.scheduleNextAlarm();
          return json({ ok: log[0]?.ok ?? false, log: log[0] });
        }
        if (suffix === "/logs" && method === "GET") {
          const limit = intParam(url.searchParams.get("limit"), 20, 1, 100);
          return json({
            logs: this.store.listLogs({
              limit,
              taskId: id,
              beforeId: intParam(url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER) || null,
            }),
          });
        }
        if (!suffix && (method === "PATCH" || method === "PUT")) {
          const patch = (await request.json()) as Partial<TaskInput>;
          const updated = this.updateTask(id, patch);
          await this.scheduleNextAlarm();
          return json({ task: updated });
        }
        if (!suffix && method === "DELETE") {
          this.store.deleteTask(id);
          await this.scheduleNextAlarm();
          return json({ ok: true });
        }
      }

      if (path === "/logs" && method === "GET") {
        const limit = intParam(url.searchParams.get("limit"), 50, 1, 200);
        const beforeId = intParam(url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER) || null;
        const level = url.searchParams.get("level");
        const taskIdParam = intParam(url.searchParams.get("taskId"), 0, 0, Number.MAX_SAFE_INTEGER) || null;
        const logs = this.store.listLogs({ limit, beforeId, level, taskId: taskIdParam });
        // 只有"这一页满了"才可能有更早的；否则前端会一直显示「加载更多」
        return json({ logs, nextBefore: logs.length === limit ? logs[logs.length - 1].id : null });
      }
      if (path === "/logs/clear" && method === "POST") {
        this.store.clearLogs();
        return json({ ok: true });
      }

      if (path === "/auth/turnstile" && method === "GET") {
        const settings = this.store.getSettings();
        const siteKey = (this.env.TURNSTILE_SITE_KEY ?? "").trim() || settings.turnstileSiteKey;
        const secretKey = (this.env.TURNSTILE_SECRET_KEY ?? "").trim() || settings.turnstileSecretKey;
        return json({
          siteKey: siteKey || null,
          secretKey: secretKey || null,
          source: (this.env.TURNSTILE_SECRET_KEY ?? "").trim() ? "env" : secretKey ? "settings" : null,
        });
      }

      if (path === "/auth/attempt" && method === "POST") {
        const body = (await request.json()) as { ip?: string; mode?: "peek" | "fail" | "success" };
        const ip = String(body.ip ?? "unknown").slice(0, 64);
        const mode = body.mode === "fail" || body.mode === "success" ? body.mode : "peek";
        const now = Date.now();
        const limit = 10;
        const windowMs = 10 * 60_000;

        if (mode === "peek") {
          const failures = this.store.countAuthFailures(ip, now - windowMs);
          return json({ allowed: failures < limit, failures, retryAfterSeconds: failures < limit ? 0 : 600 });
        }

        if (mode === "success") {
          this.store.clearAuthAttempts(ip);
          return json({ allowed: true, attempts: 0 });
        }

        const failures = this.store.recordAuthAttempt(ip, false, now);
        return json({
          allowed: failures < limit,
          failures,
          retryAfterSeconds: failures < limit ? 0 : 600,
        });
      }

      if (path === "/trigger/parse" && method === "POST") {
        const body = (await request.json()) as { text?: string };
        const settings = this.store.getSettings();
        const ctx: TriggerContext = { defaultTarget: settings.defaultTarget || undefined, allowMissingTarget: true };
        const parsed = parseTrigger(String(body.text ?? ""), ctx);
        if (!parsed.ok) return json({ ok: false, error: parsed.error });
        const result = parsed.result;
        if (result.kind !== "create" || !result.task) {
          return json({ ok: true, command: result.kind, argument: result.argument });
        }
        const now = Date.now();
        // 试算也尽量把目标补全（显示名 / access_hash），和真正建任务时保持一致
        let previewInput = result.task as TaskInput;
        if (this.session()) {
          try {
            previewInput = await this.withClient((client) => this.enrichTarget(client, result.task as TaskInput));
          } catch {
            /* 没连上就按原样展示 */
          }
        }
        if (result.autoName) {
          previewInput = { ...previewInput, name: defaultName(previewInput.target, "", previewInput.steps ?? []) };
        }
        const preview: Task = {
          ...previewInput,
          id: 0,
          nextRunAt: computeNextRun(previewInput.schedule, now, settings.timezone),
          lastRunAt: null,
          lastResult: null,
          lastMessage: null,
          createdAt: now,
          updatedAt: now,
        } as Task;
        return json({ ok: true, task: preview, explanation: result.explanation });
      }

      if (path === "/account/send-code" && method === "POST") {
        const body = (await request.json()) as { apiId?: number; apiHash?: string; phone?: string };
        return json(await this.serialize(() => this.sendCode(body)));
      }
      if (path === "/account/sign-in" && method === "POST") {
        const body = (await request.json()) as { code?: string; password?: string };
        return json(await this.serialize(() => this.signIn(body)));
      }
      if (path === "/account/logout" && method === "POST") {
        return json(await this.serialize(() => this.logout()));
      }
      if (path === "/resolve" && method === "POST") {
        const body = (await request.json()) as { query?: string };
        return json(await this.resolvePeer(String(body.query ?? "")));
      }
      if (path === "/tick" && method === "POST") {
        const ran = await this.serialize(() => this.tick());
        return json({ ok: true, ran, nextRunAt: this.store.earliestNextRun() });
      }

      return jsonError("未找到该接口", 404);
    } catch (error) {
      return jsonError(error, 500);
    }
  }

  async alarm(): Promise<void> {
    await this.serialize(() => this.tick());
  }

  // ---------------------------------------------------------------- 调度

  private pollIntervalMs(): number {
    const settings = this.store.getSettings();
    return Math.max(15, Math.min(3600, settings.pollSeconds || 60)) * 1000;
  }

  private async scheduleNextAlarm(): Promise<void> {
    const now = Date.now();
    const settings = this.store.getSettings();
    const candidates: number[] = [];

    const nextRun = this.store.earliestNextRun();
    if (nextRun) candidates.push(nextRun);

    if (settings.triggerEnabled && this.store.getKv(KV_SESSION)) {
      const lastPoll = Number(this.store.getKv("trigger:lastPoll") ?? 0);
      candidates.push(lastPoll ? lastPoll + this.pollIntervalMs() : now + 1_000);
    }

    const nextDeletion = this.store.nextDeletionAt();
    if (nextDeletion) candidates.push(nextDeletion);

    if (!candidates.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const at = Math.max(Math.min(...candidates), now + 5_000);
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || Math.abs(existing - at) > 1_000) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  private async tick(): Promise<LogEntry[]> {
    const now = Date.now();
    const settings = this.store.getSettings();
    const ran: LogEntry[] = [];
    const logs: string[] = [];

    const shouldPoll =
      settings.triggerEnabled &&
      !!this.store.getKv(KV_SESSION) &&
      now - Number(this.store.getKv("trigger:lastPoll") ?? 0) >= this.pollIntervalMs();
    const due = this.store.dueTasks(now);
    const deletions = this.store.dueDeletions(now);

    if (!shouldPoll && !due.length && !deletions.length) {
      await this.scheduleNextAlarm();
      return ran;
    }

    try {
      await this.withClient(async (client) => {
        if (deletions.length) {
          try {
            await this.processDeletions(client, deletions);
          } catch (error) {
            logs.push(`延迟删除失败：${errorMessage(error)}`);
          }
        }
        if (shouldPoll) {
          this.store.setKv("trigger:lastPoll", String(now));
          const controlChat = settings.controlChat || "self";
          try {
            await this.pollTriggers(client, logs);
          } catch (error) {
            const message = errorMessage(error);
            logs.push(`触发器轮询失败（控制会话 ${controlChat}）：${message}`);
            // 连接类错误：换一条新连接重试一次（复用的 socket 可能已经半死）
            const transient = /disconnect|not connected|socket|timeout|network|closed/i.test(message);
            let recovered = false;
            if (transient) {
              try {
                await this.dropClient();
                await this.withClient((fresh) => this.pollTriggers(fresh, logs));
                recovered = true;
                this.store.addLog({
                  taskId: null,
                  taskName: null,
                  at: Date.now(),
                  ok: true,
                  level: "info",
                  message: "触发器轮询：重连后成功",
                  detail: `控制会话 ${controlChat}`,
                });
              } catch (retryError) {
                logs.push(`重试仍失败：${errorMessage(retryError)}`);
              }
            }
            if (!recovered) {
              this.store.addLog({
                taskId: null,
                taskName: null,
                at: Date.now(),
                ok: false,
                level: "warn",
                message: `触发器轮询失败（控制会话 ${controlChat}）：${message}`,
                detail: transient ? "已自动重连重试一次，仍失败" : null,
              });
            }
          }
        }
        if (due.length) {
          // 护栏：同一任务 45 秒内不重复执行（防止调度 bug / 窗口边界造成连发）
          const runnable: Task[] = [];
          for (const task of due) {
            // 硬约束：daily / window / once 本质上"每天最多一次"，同一天内不再重复执行
            if (
              settings !== null &&
              task.schedule.kind !== "interval" &&
              task.lastRunAt &&
              isSameLocalDay(task.lastRunAt, now, settings.timezone)
            ) {
              this.store.addLog({
                taskId: task.id,
                taskName: task.name,
                at: now,
                ok: false,
                level: "warn",
                message: "跳过：今天已经执行过（每天类型任务一天只跑一次）",
                detail: `上次执行：${formatInTimezone(task.lastRunAt, settings.timezone)}`,
              });
              this.store.setTaskNextRun(
                task.id,
                computeNextRun(task.schedule, now, settings.timezone, { afterExecution: true }),
              );
              continue;
            }

            if (task.lastRunAt && now - task.lastRunAt < 45_000) {
              this.store.addLog({
                taskId: task.id,
                taskName: task.name,
                at: now,
                ok: false,
                level: "warn",
                message: `跳过：${Math.round((now - task.lastRunAt) / 1000)} 秒前刚执行过（防重复触发）`,
                detail: null,
              });
              this.store.setTaskNextRun(
                task.id,
                computeNextRun(task.schedule, now, settings.timezone, { afterExecution: true }),
              );
              continue;
            }
            runnable.push(task);
          }
          if (runnable.length) ran.push(...(await this.runTasks(runnable, client)));
        }
      });
    } catch (error) {
      // 连不上 Telegram（或凭证失效）：把到期的任务顺延，避免每个 alarm 都重试同一批
      for (const task of due) {
        if (task.schedule.kind === "once") {
          this.store.updateTask(task.id, { enabled: false, nextRunAt: null }, Date.now());
        } else {
          this.store.setTaskNextRun(task.id, computeNextRun(task.schedule, Date.now(), settings.timezone));
        }
      }
      this.store.setKv(KV_LAST_ERROR, errorMessage(error));
      this.store.addLog({
        taskId: null,
        taskName: null,
        at: Date.now(),
        ok: false,
        level: "error",
        message: `调度出错：${errorMessage(error)}`,
        detail: logs.join("\n") || null,
      });
    }

    await this.scheduleNextAlarm();
    return ran;
  }

  // ---------------------------------------------------------------- Telegram 会话

  private credentials(): Credentials {
    const stored = this.store.getJson<Credentials>(KV_CREDS, { apiId: null, apiHash: "" });
    if (stored.apiId && stored.apiHash) return stored;
    const apiId = Number(this.env.TG_API_ID ?? 0);
    const apiHash = String(this.env.TG_API_HASH ?? "");
    if (apiId && apiHash) return { apiId, apiHash };
    return stored;
  }

  private session(): string {
    return this.store.getKv(KV_SESSION) ?? "";
  }

  private requireCredentials(): { apiId: number; apiHash: string; session: string } {
    const creds = this.credentials();
    if (!creds.apiId || !creds.apiHash) throw new Error("还没配置 apiId / apiHash");
    return { apiId: Number(creds.apiId), apiHash: creds.apiHash, session: this.session() };
  }

  /** 一次操作一个连接：连上 → 干活 → 保存 session → 断开 */
  /**
   * 一次操作用一个连接；如果上一个操作刚结束不久（CLIENT_IDLE_REUSE_MS 内），
   * 直接复用仍然活着的 client，省掉一次重连 + 实体缓存回灌。
   *
   * 复用失败（socket 被 CM 掐断、DO 侧被驱逐前的半死状态）时自动重连重试一次。
   */
  private async withClient<T>(fn: (client: TelegramClient) => Promise<T>): Promise<T> {
    const creds = this.requireCredentials();
    if (!creds.session) throw new Error("还没登录 Telegram");

    this.activeOps += 1;
    try {
      const reusable = this.reusableClient(creds);
      if (reusable) {
        try {
          const result = await fn(reusable);
          this.afterUse(reusable);
          return result;
        } catch (error) {
          // 复用的连接可能已经半死：丢掉它，重连一次再试
          this.store.setKv(KV_LAST_ERROR, errorMessage(error));
          await this.dropClient();
          return await this.runWithFreshClient(creds, fn);
        }
      }

      return await this.runWithFreshClient(creds, fn);
    } finally {
      this.activeOps -= 1;
    }
  }

  private async runWithFreshClient<T>(
    creds: { apiId: number; apiHash: string; session: string },
    fn: (client: TelegramClient) => Promise<T>,
  ): Promise<T> {
    const client = createTgClient(creds);
    try {
      await client.connect();
      this.connected = true;
      this.store.setKv("connection:lastOkAt", String(Date.now()));
      this.restoreEntities(client);
      const result = await fn(client);
      this.afterUse(client);
      return result;
    } catch (error) {
      this.connected = false;
      this.store.setKv(KV_LAST_ERROR, errorMessage(error));
      throw error;
    } finally {
      if (CLIENT_IDLE_REUSE_MS > 0) this.keepWarm(client);
      else {
        await client.disconnect().catch(() => undefined);
        this.connected = false;
      }
    }
  }

  private reusableClient(creds: { apiId: number; session: string }): TelegramClient | null {
    if (CLIENT_IDLE_REUSE_MS <= 0) return null;
    const client = this.cachedClient;
    if (!client) return null;
    if (this.cachedClientKey !== `${creds.apiId}:${creds.session}`) return null;
    if (!client.connected) return null;
    return client;
  }

  /** 保存 session / 实体缓存，并刷新"最近使用"时间 */
  private afterUse(client: TelegramClient): void {
    this.persistEntities(client);
    this.persistSession(client);
    this.store.deleteKv(KV_LAST_ERROR);
    this.cachedClientTouchedAt = Date.now();
  }

  private keepWarm(client: TelegramClient): void {
    this.cachedClient = client;
    this.cachedClientKey = this.credentialsKey();
    this.cachedClientTouchedAt = Date.now();
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // 还有操作在跑：绝对不能断开，等它结束后 afterUse() 会重新排计时器
      if (this.activeOps > 0) return;
      const idleFor = Date.now() - this.cachedClientTouchedAt;
      if (idleFor >= CLIENT_IDLE_REUSE_MS) void this.dropClient();
      else this.keepWarm(this.cachedClient as TelegramClient);
    }, CLIENT_IDLE_REUSE_MS);
  }

  private credentialsKey(): string {
    const creds = this.credentials();
    return `${creds.apiId}:${this.session()}`;
  }

  /** 丢弃缓存的连接（登录态变化、出错、空闲超时都会走这里） */
  private async dropClient(): Promise<void> {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const client = this.cachedClient;
    this.cachedClient = null;
    this.cachedClientKey = null;
    this.connected = false;
    if (client) await client.disconnect().catch(() => undefined);
  }

  /**
   * 登录阶段的连接封装。
   *
   * 账号归属的 DC 不是默认 DC2 时，Telegram 会返回 `PHONE_MIGRATE_5` 之类的错误，
   * 要求去目标 DC 上重新发起登录（验证码要在那个 DC 上申请）。
   * teleproto 内部的重试本来会处理，但登录流程要拿到迁移后的 session，
   * 这里再自己兜一层：命中迁移错误就换到目标 DC 重连重试一次。
   */
  private async withLoginClient<T>(
    creds: { apiId: number; apiHash: string; session?: string },
    fn: (client: TelegramClient) => Promise<T>,
    options: { retryOnMigrate: boolean; startDc?: number | null } = { retryOnMigrate: true },
  ): Promise<T> {
    let pinnedDc: number | null = options.startDc ?? null;
    let retried = false;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const usePinned = pinnedDc !== null && !creds.session;
      const client = usePinned
        ? createTgClientOnDc(creds, pinnedDc as number)
        : createTgClient({ apiId: creds.apiId, apiHash: creds.apiHash, session: creds.session ?? "" });
      try {
        await client.connect();
        return await fn(client);
      } catch (error) {
        lastError = error;
        const targetDc = migrateDcFromError(error);
        if (targetDc !== null) this.store.setKv("account:dc", String(targetDc));
        if (targetDc !== null && options.retryOnMigrate && !retried) {
          retried = true;
          pinnedDc = targetDc;
          continue;
        }
        if (targetDc !== null && !options.retryOnMigrate) {
          throw new Error(
            `该账号归属 DC${targetDc}，验证码需要在该数据中心申请：请重新点击「获取验证码」再登录（已自动记住 DC${targetDc}）`,
          );
        }
        if (targetDc !== null) {
          // 已经在目标 DC 上重试过，仍被要求迁移 —— 把上下文说清楚，方便排查
          throw new Error(
            `账号归属 DC${targetDc}，已在该 DC 重试仍被要求迁移（${errorMessage(error)}）。` +
              `请确认 apiId/apiHash 属于你自己的应用，并稍后重试`,
          );
        }
        throw error;
      } finally {
        await client.disconnect().catch(() => undefined);
      }
    }

    throw lastError ?? new Error("登录失败");
  }

  /** 把落地的实体缓存灌回新 client 的 session */
  private restoreEntities(client: TelegramClient): void {
    try {
      const rows = this.store.getJson<Array<[string, string, string | null, string | null, string | null]>>(
        KV_ENTITIES,
        [],
      );
      if (!rows.length) return;
      const cache = (client.session as unknown as { _entities?: Map<string, unknown> })._entities;
      if (!cache) return;
      for (const row of rows) {
        if (row?.[0]) cache.set(String(row[0]), row);
      }
    } catch {
      /* 缓存不可用就算了 */
    }
  }

  /** 把 session 里的实体缓存落地，下次连接直接用 */
  private persistEntities(client: TelegramClient): void {
    try {
      const cache = (client.session as unknown as { _entities?: Map<string, unknown[]> })._entities;
      if (!cache || cache.size === 0) return;
      const rows = [...cache.values()]
        .slice(-600)
        .map((row) => [
          row[0] != null ? String(row[0]) : "",
          row[1] != null ? String(row[1]) : "",
          (row[2] as string | null) ?? null,
          (row[3] as string | null) ?? null,
          (row[4] as string | null) ?? null,
        ]);
      this.store.setJson(KV_ENTITIES, rows);
    } catch {
      /* 忽略 */
    }
  }

  private persistSession(client: TelegramClient): void {
    try {
      const saved = client.session.save();
      if (typeof saved === "string" && saved) this.store.setKv(KV_SESSION, saved);
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- 账号

  private async sendCode(body: { apiId?: number; apiHash?: string; phone?: string }) {
    const apiId = Number(body.apiId ?? this.credentials().apiId ?? 0);
    const apiHash = String(body.apiHash ?? this.credentials().apiHash ?? "");
    const phone = String(body.phone ?? "").trim();
    if (!apiId || !apiHash) throw new Error("请填写 apiId 和 apiHash（my.telegram.org 获取）");
    if (!phone) throw new Error("请填写手机号（含国家码，例如 +8613800000000）");

    this.store.setJson(KV_CREDS, { apiId, apiHash });

    const knownDc = Number(this.store.getKv("account:dc") ?? 0) || null;
    const { result, session } = await this.withLoginClient(
      { apiId, apiHash },
      async (client) => {
        const sent = (await client.sendCode({ apiId, apiHash }, phone)) as {
          phoneCodeHash: string;
          isCodeViaApp: boolean;
        };
        return { result: sent, session: String(client.session.save() ?? "") };
      },
      { retryOnMigrate: true, startDc: knownDc },
    );

    const pending: PendingLogin = {
      apiId,
      apiHash,
      phone,
      phoneCodeHash: result.phoneCodeHash,
      session,
      stage: "code",
      at: Date.now(),
    };
    this.store.setJson(KV_PENDING, pending);
    return {
      stage: "code" as const,
      hint: result.isCodeViaApp ? "验证码已发送到 Telegram App" : "验证码已通过短信发送",
      dc: session ? Number(this.store.getKv("account:dc") ?? 0) || undefined : undefined,
    };
  }

  private async signIn(body: { code?: string; password?: string }) {
    const pending = this.store.getJson<PendingLogin | null>(KV_PENDING, null);
    if (!pending) throw new Error("请先获取验证码");
    if (Date.now() - pending.at > 10 * 60_000) {
      this.store.deleteKv(KV_PENDING);
      throw new Error("验证码已过期，请重新获取");
    }

    const outcome = await this.withLoginClient(
      { apiId: pending.apiId, apiHash: pending.apiHash, session: pending.session },
      async (client): Promise<{ kind: "password" } | { kind: "ok"; me: { id: string; username: string | null; firstName: string } }> => {
        if (body.code) {
          try {
            const auth = await client.invoke(
              new Api.auth.SignIn({
                phoneNumber: pending.phone,
                phoneCodeHash: pending.phoneCodeHash,
                phoneCode: String(body.code).trim(),
              }),
            );
            if (auth.className === "auth.AuthorizationSignUpRequired") {
              throw new Error("该号码还没有 Telegram 账号，请先在官方客户端注册");
            }
          } catch (error) {
            const message = errorMessage(error);
            if (message === "SESSION_PASSWORD_NEEDED") {
              this.store.setJson(KV_PENDING, {
                ...pending,
                stage: "password",
                session: String(client.session.save() ?? pending.session),
              } satisfies PendingLogin);
              return { kind: "password" };
            }
            if (message === "PHONE_CODE_INVALID") throw new Error("验证码不正确");
            if (message === "PHONE_CODE_EXPIRED") throw new Error("验证码已过期，请重新获取");
            throw error;
          }
        } else if (body.password) {
          const passwordInfo = await client.invoke(new Api.account.GetPassword());
          const check = await PasswordModule.computeCheck(passwordInfo, String(body.password));
          await client.invoke(new Api.auth.CheckPassword({ password: check }));
        } else {
          throw new Error("请填写验证码或两步验证密码");
        }

        const me = (await client.getMe()) as Api.User;
        const info = {
          id: String(me.id),
          username: me.username ?? null,
          firstName: me.firstName || me.username || "Telegram 用户",
        };
        this.store.setKv(KV_SESSION, String(client.session.save() ?? ""));
        this.store.setJson(KV_ME, info);
        return { kind: "ok", me: info };
      },
      { retryOnMigrate: false },
    );

    if (outcome.kind === "password") return { stage: "password" as const };

    this.store.setKv(KV_PHONE, pending.phone);
    this.store.deleteKv(KV_PENDING);
    this.store.deleteKv(KV_LAST_ERROR);
    this.resetTriggerCursor();
    await this.scheduleNextAlarm();
    return { ok: true as const, me: outcome.me };
  }

  private async logout() {
    const session = this.session();
    if (session) {
      try {
        const creds = this.credentials();
        if (creds.apiId && creds.apiHash) {
          const client = createTgClient({ apiId: Number(creds.apiId), apiHash: creds.apiHash, session });
          await client.connect();
          await client.invoke(new Api.auth.LogOut()).catch(() => undefined);
          await client.disconnect().catch(() => undefined);
        }
      } catch {
        /* 忽略：本地登出优先 */
      }
    }
    await this.dropClient();
    this.store.deleteKv(KV_SESSION);
    this.store.deleteKv(KV_ME);
    this.store.deleteKv(KV_PENDING);
    this.resetTriggerCursor();
    await this.scheduleNextAlarm();
    return { ok: true };
  }

  private async resolvePeer(query: string) {
    const raw = query.trim();
    if (!raw) throw new Error("目标为空");
    return this.withClient(async (client) => {
      const entity = await resolveEntity(client, raw);
      return { peer: await this.toTarget(client, entity, raw) };
    });
  }

  // ---------------------------------------------------------------- 触发消息

  /** 最近一次登记的目标（30 分钟内有效） */
  private rememberedTarget(): Target | null {
    const stored = this.store.getJson<{ target?: Target; at?: number } | null>(KV_TRIGGER_TARGET, null);
    if (!stored?.target || !stored.at) return null;
    if (Date.now() - stored.at > 30 * 60_000) return null;
    return stored.target;
  }

  private resetTriggerCursor(): void {
    const settings = this.store.getSettings();
    this.store.deleteKv(`trigger:cursor:${settings.controlChat || "self"}`);
  }

  private async pollTriggers(client: TelegramClient, logs: string[]): Promise<void> {
    const settings = this.store.getSettings();
    const controlRef = settings.controlChat || "self";
    const entity = await resolveEntity(client, controlRef);
    const cursorKey = `trigger:cursor:${controlRef}`;
    const cursor = Number(this.store.getKv(cursorKey) ?? 0);

    const messages = (await client.getMessages(entity as never, { limit: 20 })) as Api.Message[];
    if (!messages.length) return;
    const highest = Math.max(cursor, ...messages.map((message) => message.id));

    if (!cursor) {
      // 首次只记录游标，避免把历史消息全解析一遍
      this.store.setKv(cursorKey, String(highest));
      // 把这件事写进日志：否则"发了配置却没反应"会让人以为是坏了
      this.store.addLog({
        taskId: null,
        taskName: null,
        at: Date.now(),
        ok: true,
        level: "info",
        message: `触发器首次轮询：记录游标 #${highest}（之前的历史消息不处理，从现在开始监听）`,
        detail: `控制会话：${controlRef}\n如果刚刚发过配置，请再发一次。`,
      });
      const greetKey = `trigger:greeted:${controlRef}`;
      if (!this.store.getKv(greetKey)) {
        this.store.setKv(greetKey, "1");
        await client
          .sendMessage(entity as never, { message: WELCOME_TEXT, parseMode: false })
          .catch(() => undefined);
      }
      return;
    }

    const fresh = messages.filter((message) => message.id > cursor).sort((a, b) => a.id - b.id);
    if (fresh.length) {
      logs.push(`本轮轮询：${fresh.length} 条新消息（cursor=${cursor} → ${highest}）`);
      this.store.addLog({
        taskId: null,
        taskName: null,
        at: Date.now(),
        ok: true,
        level: "info",
        message: `触发器轮询：发现 ${fresh.length} 条新消息`,
        detail: fresh.map((item) => `#${item.id} ${(item.message ?? "").slice(0, 80).replace(/\n/g, " / ") || "（无文本）"}`).join("\n"),
      });
    }
    for (const message of fresh) {
      try {
        await this.handleTriggerMessage(client, entity, message, settings, logs);
      } catch (error) {
        this.store.addLog({
          taskId: null,
          taskName: null,
          at: Date.now(),
          ok: false,
          level: "error",
          message: `处理触发消息失败：${errorMessage(error)}`,
          detail: (message.message ?? "").slice(0, 500),
        });
      }
    }
    this.store.setKv(cursorKey, String(highest));
  }

  private async handleTriggerMessage(
    client: TelegramClient,
    entity: Parameters<TelegramClient["sendMessage"]>[0],
    message: Api.Message,
    settings: Settings,
    logs: string[],
  ): Promise<void> {
    const raw = (message.message ?? "").trim();
    // 超长消息不解析（保护 CPU，也避免被拿来塞垃圾）
    const text = raw.slice(0, 2000);

    /** 识别链路，最后统一写进日志 detail —— 出了问题能一眼看到卡在哪 */
    const trace: string[] = [
      `消息 #${message.id}：${text.replace(/\n/g, " / ").slice(0, 120) || "（无文本）"}`,
      `out=${String(message.out)} senderId=${String(message.senderId ?? "—")} 控制会话=${settings.controlChat || "self"}`,
    ];
    const record = (ok: boolean, summary: string, extra?: { taskId?: number; taskName?: string }) => {
      this.store.setJson("trigger:lastEvent", {
        at: Date.now(),
        ok,
        message: summary,
        detail: trace.join("\n"),
      });
      this.store.addLog({
        taskId: extra?.taskId ?? null,
        taskName: extra?.taskName ?? null,
        at: Date.now(),
        ok,
        level: ok ? "info" : "warn",
        message: summary,
        detail: trace.join("\n"),
      });
    };

    if (!text || isOwnReply(text)) return;

    if (settings.adminUserId && String(message.senderId ?? "") && String(message.senderId) !== settings.adminUserId) {
      trace.push(`忽略：发送者不是配置的 adminUserId（${settings.adminUserId}）`);
      record(false, "忽略触发消息：发送者不是管理员");
      return;
    }

    // 控制会话是群组、又没配 adminUserId 时，只认「自己发的」消息。
    // 否则群里任何人都能让我这个账号往任意聊天发消息（等于开放了发信能力）。
    const controlChatIsSelf = (settings.controlChat || "self") === "self";
    if (!controlChatIsSelf && !settings.adminUserId && !message.out) {
      trace.push("忽略：群聊控制会话未配 adminUserId，且消息不是本人发的");
      record(false, "忽略触发消息：群聊里请到设置填 adminUserId");
      return;
    }

    const reply = async (body: string) => {
      await client.sendMessage(entity as never, { message: body, parseMode: false });
    };

    // 机器人自己发来的消息不当作配置（控制会话设成机器人的聊天时，别把欢迎语当指令）
    if (!message.out) {
      const sender = message.senderId as { className?: string; userId?: unknown } | undefined;
      if (sender?.className === "PeerUser") {
        try {
          const entityOfSender = await client.getEntity(sender as never);
          if ((entityOfSender as unknown as { bot?: boolean }).bot) return;
        } catch {
          /* 拿不到就按普通消息处理 */
        }
      }
    }

    // 这条消息自己指向谁（转发来源 / 联系人卡片 / 链接 / 回复的那条 / 最近的上一条）
    const hint = await this.inferTarget(client, entity, message);
    const hasTime = Boolean(findTimeToken(tokenize(text)));

    // 没有时间表达式 → 当成「目标登记」。
    // 常见操作是「先转发机器人到收藏夹，再单独发一条 9.30 签到」；
    // 纯转发不回复（否则机器人每转发一次都要被数落一顿），只在完全看不懂时才提示。
    if (!hasTime) {
      if (hint) {
        this.store.setJson(KV_TRIGGER_TARGET, { target: hint, at: Date.now() });
        logs.push(`登记目标：${hint.username ?? hint.title ?? hint.id}`);
        trace.push(`没有时间表达式 → 只登记目标：${JSON.stringify(hint)}`);
        record(true, `登记目标：${hint.title || (hint.username ? `@${hint.username}` : hint.id)}`);
        return;
      }
      trace.push("没有时间表达式，也没有可识别的目标 → 回帮助文本");
      record(false, "触发消息无法识别（缺时间/目标），已回帮助文本");
      await reply(HELP_TEXT);
      return;
    }

    const ctx: TriggerContext = {
      defaultTarget: settings.defaultTarget || undefined,
      forwarded: hint ?? this.rememberedTarget(),
      sourceChat: await this.toTarget(client, entity, ""),
    };

    trace.push(
      `上下文：推断目标=${hint ? JSON.stringify(hint) : "无"} 记住的目标=${this.rememberedTarget() ? "有" : "无"} 默认目标=${settings.defaultTarget || "无"}`,
    );

    const parsed = parseTrigger(text, ctx);
    if (!parsed.ok) {
      trace.push(`解析失败：${parsed.error}`);
      record(false, `触发解析失败：${parsed.error}`);
      await reply(`⚠️ ${parsed.error}`);
      return;
    }

    const result = parsed.result;
    logs.push(`${result.kind}: ${text.slice(0, 60)}`);

    switch (result.kind) {
      case "help": {
        trace.push("命令：帮助");
        record(true, "触发器命令：帮助");
        await reply(HELP_TEXT);
        return;
      }
      case "list": {
        trace.push("命令：列表");
        record(true, "触发器命令：列表");
        await reply(this.renderTaskList());
        return;
      }
      case "create": {
        const incoming = result.task as TaskInput;
        trace.push(
          `推断到的目标：${
            hint
              ? `${hint.title ?? ""}${hint.title && hint.username ? " " : ""}${hint.username ? `@${hint.username}` : ""}（kind=${hint.kind} id=${hint.id}${
                  hint.accessHash ? " hash=有" : ""
                }）`.trim()
              : "无（使用记住的目标 / 默认目标）"
          }`,
        );
        const enriched = await this.enrichTarget(client, incoming, trace);
        // 自动生成的名字要用「补全后的目标」重新算，否则会留下旧标签（@username）
        if (result.autoName) {
          const regenerated = defaultName(enriched.target, "", enriched.steps ?? []);
          if (regenerated !== enriched.name) {
            trace.push(`任务名按最终目标生成：${regenerated}（原：${enriched.name}）`);
            enriched.name = regenerated;
          }
        }
        trace.push(`目标最终：${JSON.stringify(enriched.target)}`);
        trace.push(`调度：${JSON.stringify(enriched.schedule)}`);
        trace.push(`动作：${(enriched.steps ?? []).map((step) => step.type).join(" → ")}`);

        const { task, created } = this.createTask(enriched);
        trace.push(created ? `建任务：#${task.id}` : `已存在相同任务 #${task.id}，未重复创建`);
        record(true, created ? `触发器创建任务 #${task.id}` : `跳过重复任务（已有 #${task.id}）`, {
          taskId: task.id,
          taskName: task.name,
        });
        await reply(
          created
            ? `✅ 已创建任务 #${task.id}\n${task.name}\n⏰ ${formatInTimezone(task.nextRunAt, settings.timezone)}（${settings.timezone >= 0 ? "+" : ""}${settings.timezone}）\n${result.explanation ?? ""}`
            : `ℹ️ 已存在相同任务 #${task.id}（${task.name}），没有重复创建\n如需重建，先发「删除 ${task.id}」`,
        );
        return;
      }
      case "run":
      case "enable":
      case "disable":
      case "delete": {
        const found = this.store.findTask(result.argument ?? "");
        if (!found) {
          await reply(`❌ 没找到任务「${result.argument ?? ""}」，发「列表」看看`);
          return;
        }
        if (result.kind === "delete") {
          trace.push(`命令：删除任务 #${found.id}`);
          record(true, `触发器命令：删除 #${found.id}`, { taskId: found.id, taskName: found.name });
          this.store.deleteTask(found.id);
          await this.scheduleNextAlarm();
          await reply(`🗑️ 已删除任务 #${found.id} ${found.name}`);
          return;
        }
        if (result.kind === "enable" || result.kind === "disable") {
          this.updateTask(found.id, { enabled: result.kind === "enable" });
          await this.scheduleNextAlarm();
          await reply(`${result.kind === "enable" ? "✅" : "⏸️"} 任务 #${found.id} 已${result.kind === "enable" ? "启用" : "禁用"}`);
          return;
        }
        const task = this.store.getTask(found.id)!;
        trace.push(`命令：立即执行任务 #${task.id}`);
        record(true, `触发器命令：立即执行 #${task.id}`, { taskId: task.id, taskName: task.name });
        const [log] = await this.runTasks([task], client, { manual: true });
        await reply(`${log.ok ? "✅" : "❌"} 任务 #${task.id} ${task.name}\n${log.message}${log.detail ? `\n${log.detail}` : ""}`.slice(0, 3500));
        return;
      }
      default:
        await reply(HELP_TEXT);
    }
  }

  /**
   * 推断签到目标。用户表达"发给谁"的方式，按可信度从高到低：
   *
   *  1. 转发 / 分享机器人消息 → fwd_from.from_id
   *  2. **回复了机器人的某条消息** → 取被回复消息的发送者 / 转发来源
   *  3. 分享联系人卡片 → media.user_id
   *  4. 内联机器人 → via_bot_id
   *  5. 文本或网页预览里的 t.me 链接
   *
   * 注：触发消息本身的发送者永远是账号自己，所以只在"被回复的消息"里才看发送者。
   */
  private async inferTarget(
    client: TelegramClient,
    chat: Parameters<TelegramClient["sendMessage"]>[0],
    message: Api.Message,
  ): Promise<Target | null> {
    const direct = await this.resolveHint(client, messageTargetHint(message as unknown as MessageLike, { allowSender: false }));
    if (direct) return direct;

    const replyTo = (message as unknown as {
      replyTo?: { replyToMsgId?: number; replyToPeerId?: unknown };
    }).replyTo;

    // 跨会话回复（新版 layer 才有 reply_to_peer_id）
    if (replyTo?.replyToPeerId) {
      try {
        const entity = await client.getEntity(replyTo.replyToPeerId as never);
        return await this.toTarget(client, entity, "");
      } catch {
        /* 忽略，继续走同会话回复 */
      }
    }

    // 同会话回复：把被回复的那条消息捞出来再推断一次
    const repliedId = replyTo?.replyToMsgId;
    if (repliedId) {
      try {
        const [replied] = (await client.getMessages(chat as never, { ids: [repliedId] })) as Api.Message[];
        if (replied) {
          const fromReplied = await this.resolveHint(
            client,
            messageTargetHint(replied as unknown as MessageLike, { allowSender: true }),
          );
          if (fromReplied) return fromReplied;
        }
      } catch {
        /* 忽略 */
      }
    }

    return null;
  }

  /** 把纯函数里提取出的线索换成真实实体 */
  private async resolveHint(client: TelegramClient, hint: MessageTargetHint | null): Promise<Target | null> {
    if (!hint) return null;

    if (hint.kind === "peer") {
      const peer = hint.peer;
      const instance =
        peer.className === "PeerChannel"
          ? new Api.PeerChannel({ channelId: peer.channelId as never })
          : peer.className === "PeerChat"
            ? new Api.PeerChat({ chatId: peer.chatId as never })
            : new Api.PeerUser({ userId: peer.userId as never });
      try {
        const entity = await client.getEntity(instance as never);
        // 线索来自"发送者"时，只认机器人/频道/群，避免群里随便谁的发言都被当成目标
        if (hint.fromSender && peer.className === "PeerUser") {
          const isBot = Boolean((entity as unknown as { bot?: boolean }).bot);
          if (!isBot) return null;
        }
        return await this.toTarget(client, entity, "");
      } catch {
        return null;
      }
    }

    if (hint.kind === "username") {
      try {
        const entity = await client.getEntity(hint.value);
        return await this.toTarget(client, entity, hint.value);
      } catch {
        return { kind: "user", id: hint.value, username: hint.value };
      }
    }

    return null;
  }

  private async toTarget(client: TelegramClient, entity: unknown, fallback: string): Promise<Target> {
    const anyEntity = entity as {
      className?: string;
      id?: unknown;
      title?: string;
      firstName?: string;
      lastName?: string;
      username?: string;
      accessHash?: unknown;
    };
    const kind = anyEntity.className === "Channel" ? "channel" : anyEntity.className === "Chat" ? "chat" : "user";
    let id = String(anyEntity.id ?? fallback);
    try {
      id = (await client.getPeerId(entity as never)) ?? id;
    } catch {
      /* ignore */
    }
    // 显示名：群/频道用 title，用户用「名 + 姓」，都没有才退回 username / id
    const displayName =
      anyEntity.title ||
      [anyEntity.firstName, anyEntity.lastName].filter(Boolean).join(" ").trim() ||
      undefined;
    const title = displayName && displayName !== `@${anyEntity.username ?? ""}` ? displayName : displayName;
    const accessHash = anyEntity.accessHash;
    return {
      kind,
      id,
      title,
      username: anyEntity.username,
      // 记下 access_hash：私有机器人/用户没有 username 时，只能靠它解析
      ...(accessHash !== undefined && accessHash !== null ? { accessHash: String(accessHash) } : {}),
    };
  }

  private renderTaskList(): string {
    const tasks = this.store.listTasks();
    if (!tasks.length) return "📋 还没有任务。在收藏夹发一条 `9.30 签到` 试试，或发「帮助」看语法。";
    const settings = this.store.getSettings();
    const lines = tasks.map((task) => {
      const status = task.enabled ? "✅" : "❌";
      const target = task.target.username ? `@${task.target.username}` : task.target.title || task.target.id;
      const next = formatInTimezone(task.nextRunAt, settings.timezone);
      const last = task.lastResult === "ok" ? "上次成功" : task.lastResult === "fail" ? "上次失败" : "还没跑过";
      return `${status} #${task.id} ${task.name}\n   目标 ${target} · 下次 ${next} · ${last}`;
    });
    return ["📋 任务列表", ...lines, "", "发「立即 <编号>」「开启 <编号>」「关闭 <编号>」「删除 <编号>」管理"].join("\n");
  }

  // ---------------------------------------------------------------- 任务

  /**
   * 补全目标任务信息。
   *
   * DSL 里从链接（`https://t.me/xxx_bot 9.30 签到`）解析出来的目标只有 username，
   * 没有显示名 —— 直接建任务就会得到 `@xxx_bot 签到` 这种名字。
   * 这里用当前连接把实体解析出来，补上 title / access_hash。
   */
  private async enrichTarget(client: TelegramClient, input: TaskInput, trace?: string[]): Promise<TaskInput> {
    const label = input.target.username ? `@${input.target.username}` : input.target.id;
    if (input.target.title && input.target.accessHash) {
      trace?.push(`目标已带显示名：${input.target.title}（${label}）`);
      return input;
    }
    try {
      trace?.push(`解析目标 ${label} …`);
      const entity = await resolveEntity(client, input.target);
      const target = await this.toTarget(client, entity, input.target.id);
      trace?.push(
        `解析成功：kind=${target.kind} id=${target.id} title=${target.title ?? "（无）"} ` +
          `username=${target.username ? `@${target.username}` : "（无）"} access_hash=${target.accessHash ? "有" : "无"}`,
      );
      const merged: Target = { ...target, id: target.id || input.target.id };
      const name = renameForTarget(input.name, input.target, merged);
      if (name !== input.name) trace?.push(`任务名同步：${input.name} → ${name}`);
      return { ...input, name, target: merged };
    } catch (error) {
      // 不再静默丢弃：把原因写进日志
      trace?.push(`解析失败：${errorMessage(error)}`);
      return input;
    }
  }

  /** 建任务；如果已存在完全相同的任务则不重复创建（返回 existing） */
  private createTask(input: TaskInput): { task: Task; created: boolean } {
    const settings = this.store.getSettings();
    const now = Date.now();
    const normalized = normalizeTaskInput(input);

    const duplicate = this.store.findDuplicateTask(normalized);
    if (duplicate) {
      this.store.addLog({
        taskId: duplicate.id,
        taskName: duplicate.name,
        at: now,
        ok: true,
        level: "warn",
        message: `跳过重复任务：#${duplicate.id} 已存在相同的目标/调度/动作`,
        detail: "同一条触发配置发多次、或反复点保存，都会产生重复任务；这里直接复用已有的。",
      });
      return { task: duplicate, created: false };
    }

    const nextRunAt = normalized.enabled ? computeNextRun(normalized.schedule, now, settings.timezone) : null;
    return { task: this.store.createTask(normalized, now, nextRunAt), created: true };
  }

  private updateTask(id: number, patch: Partial<TaskInput>): Task | null {
    const settings = this.store.getSettings();
    const current = this.store.getTask(id);
    if (!current) return null;
    const merged = { ...current, ...patch } as Task;
    const normalized = normalizeTaskInput(merged);
    const scheduleChanged =
      JSON.stringify(current.schedule) !== JSON.stringify(normalized.schedule) || current.enabled !== normalized.enabled;
    const nextRunAt = normalized.enabled
      ? scheduleChanged || !current.nextRunAt
        ? computeNextRun(normalized.schedule, Date.now(), settings.timezone)
        : current.nextRunAt
      : null;
    return this.store.updateTask(id, { ...normalized, nextRunAt }, Date.now());
  }

  /**
   * @param options.manual 手动触发（界面按钮 / Telegram 命令）。
   *   手动跑一次不应该打乱定时：只有「已经到期」或「本来就没排期」的任务才重算 nextRunAt，
   *   也不会把 once 任务提前消费掉。
   */
  private async runTasks(
    tasks: Task[],
    client?: TelegramClient,
    options: { manual?: boolean } = {},
  ): Promise<LogEntry[]> {
    const runner = async (tg: TelegramClient): Promise<LogEntry[]> => {
      const results: LogEntry[] = [];
      for (const task of tasks) {
        results.push(await this.runSingleTask(tg, task, options));
      }
      return results;
    };
    if (client) return runner(client);
    try {
      return await this.withClient(runner);
    } catch (error) {
      // 连接 / 凭证级失败：也落日志，让界面看得到，而不是只回一个 500
      const message = errorMessage(error);
      return tasks.map((task) =>
        this.store.addLog({
          taskId: task.id,
          taskName: task.name,
          at: Date.now(),
          ok: false,
          level: "error",
          message,
          detail: null,
        }),
      );
    }
  }

  private async runAllTasks(): Promise<LogEntry[]> {
    const tasks = this.store.listTasks().filter((task) => task.enabled);
    if (!tasks.length) return [];
    return this.runTasks(tasks, undefined, { manual: true });
  }

  /**
   * 解析任务目标（每次运行只解析一次）。
   *
   * - 解析本身有兜底：@username → access_hash → getDialogs 预热后重试（见 executor.resolveEntity）
   * - 解析成功后顺手把 username / accessHash 回填进任务，下次就不必再靠 getDialogs
   */
  private async ensureTarget(
    client: TelegramClient,
    task: Task,
  ): Promise<{ entity: Awaited<ReturnType<typeof resolveEntity>>; task: Task }> {
    const entity = await resolveEntity(client, task.target);

    // 目标里缺 username / accessHash / 显示名时补一次，之后每次解析都能直接命中
    if (!task.target.username || !task.target.accessHash || !task.target.title) {
      const peerId = await client.getPeerId(entity as never).catch(() => null);
      const anyEntity = entity as unknown as {
        username?: string;
        accessHash?: unknown;
        title?: string;
        firstName?: string;
        lastName?: string;
      };
      const displayName =
        anyEntity.title ||
        [anyEntity.firstName, anyEntity.lastName].filter(Boolean).join(" ").trim() ||
        undefined;
      const patch: Target = {
        ...task.target,
        id: peerId ? String(peerId) : task.target.id,
        username: task.target.username ?? anyEntity.username,
        title: task.target.title ?? displayName,
        ...(task.target.accessHash
          ? { accessHash: task.target.accessHash }
          : anyEntity.accessHash !== undefined && anyEntity.accessHash !== null
            ? { accessHash: String(anyEntity.accessHash) }
            : {}),
      };
      if (JSON.stringify(patch) !== JSON.stringify(task.target)) {
        // 任务名如果是当初按「@username + 动作」自动生成的，跟着换成显示名
        const renamed = renameForTarget(task.name, task.target, patch);
        const renameTo = renamed !== task.name ? renamed : null;

        const updated = this.store.updateTask(
          task.id,
          renameTo ? { target: patch, name: renameTo } : { target: patch },
          Date.now(),
        );
        this.store.addLog({
          taskId: task.id,
          taskName: renameTo ?? task.name,
          at: Date.now(),
          ok: true,
          level: "info",
          message: `目标已自动补全：${patch.title || (patch.username ? `@${patch.username}` : patch.id)}`,
          detail: renameTo ? `任务名同步更新为「${renameTo}」` : null,
        });
        return { entity, task: updated ?? { ...task, target: patch, ...(renameTo ? { name: renameTo } : {}) } };
      }
    }

    return { entity, task };
  }

  private async runSingleTask(
    client: TelegramClient,
    task: Task,
    options: { manual?: boolean } = {},
  ): Promise<LogEntry> {
    const settings = this.store.getSettings();
    const sentKey = `task:${task.id}:sent`;
    const previousSent = this.store.getJson<number[]>(sentKey, []);
    const hooks: ExecHooks = { log: () => undefined };

    let log: LogEntry;
    try {
      const settings = this.store.getSettings();
      const prepared = await this.ensureTarget(client, task);
      task = prepared.task;
      const outcome = await executeTask(client, task, {
        previousSent,
        hooks,
        entity: prepared.entity,
        pollIntervalMs: (settings.stepPollSeconds ?? 3) * 1000,
        stepWaitMs: (settings.stepWaitSeconds ?? 30) * 1000,
      });
      this.store.setJson(sentKey, outcome.sent);
      if (task.deleteAfterSeconds > 0 && outcome.sent.length) {
        this.store.addDeletion(outcome.chatId ?? task.target.id, outcome.sent, Date.now() + task.deleteAfterSeconds * 1000);
      }
      this.store.recordRun(task.id, outcome.ok ? "ok" : "fail", outcome.message, outcome.detail || null, Date.now());
      log = this.store.addLog({
        taskId: task.id,
        taskName: task.name,
        at: Date.now(),
        ok: outcome.ok,
        level: outcome.ok ? "info" : "warn",
        message: outcome.message,
        detail: outcome.detail || null,
      });
    } catch (error) {
      const message = errorMessage(error);
      this.store.recordRun(task.id, "fail", message, null, Date.now());
      log = this.store.addLog({
        taskId: task.id,
        taskName: task.name,
        at: Date.now(),
        ok: false,
        level: "error",
        message,
        detail: null,
      });
    }

    // 计算下一次执行：手动跑一次不打乱定时
    const wasDue = task.nextRunAt !== null && task.nextRunAt <= Date.now();
    const shouldReschedule = !options.manual || wasDue;
    const fresh = this.store.getTask(task.id);
    if (fresh && shouldReschedule) {
      if (fresh.schedule.kind === "once") {
        this.store.updateTask(fresh.id, { enabled: false, nextRunAt: null }, Date.now());
      } else if (fresh.enabled) {
        this.store.setTaskNextRun(
          fresh.id,
          computeNextRun(fresh.schedule, Date.now(), settings.timezone, { afterExecution: true }),
        );
      }
    }
    return log;
  }

  private async processDeletions(
    client: TelegramClient,
    deletions: Array<{ id: number; chat: string; msgIds: number[] }>,
  ): Promise<void> {
    for (const deletion of deletions) {
      try {
        const entity = await resolveEntity(client, deletion.chat);
        await client.deleteMessages(entity as never, deletion.msgIds, { revoke: true });
      } catch {
        /* 删除失败无所谓 */
      }
      this.store.deleteDeletion(deletion.id);
    }
  }

  // ---------------------------------------------------------------- 状态

  /** 下一次触发器轮询时间（没登录 / 关了触发消息就是 null） */
  private nextPollAt(): number | null {
    const settings = this.store.getSettings();
    if (!settings.triggerEnabled || !this.store.getKv(KV_SESSION)) return null;
    const lastPoll = Number(this.store.getKv("trigger:lastPoll") ?? 0);
    return lastPoll ? lastPoll + this.pollIntervalMs() : Date.now();
  }

  private async buildState(): Promise<AgentState> {
    const settings = this.store.getSettings();
    const tasks = this.store.listTasks();
    const me = this.store.getJson<AccountInfo["me"]>(KV_ME, null);
    const creds = this.credentials();
    const pending = this.store.getJson<PendingLogin | null>(KV_PENDING, null);
    const lastRunAt = tasks.reduce<number | null>((acc, task) => {
      if (!task.lastRunAt) return acc;
      return acc === null ? task.lastRunAt : Math.max(acc, task.lastRunAt);
    }, null);

    return {
      account: {
        configured: !!creds.apiId && !!creds.apiHash,
        apiId: creds.apiId ? Number(creds.apiId) : null,
        phone: pending?.phone ?? this.store.getKv(KV_PHONE),
        signedIn: !!this.session() && !!me,
        me,
        connected: this.connected,
        lastConnectedAt: Number(this.store.getKv("connection:lastOkAt") ?? 0) || null,
        pendingLogin: pending ? { phone: pending.phone, stage: pending.stage } : null,
        dc: Number(this.store.getKv("account:dc") ?? 0) || null,
        lastError: this.store.getKv(KV_LAST_ERROR),
      },
      settings: redactSettings(settings),
      tasks,
      logs: this.store.listLogs({ limit: 50 }),
      stats: {
        totalTasks: tasks.length,
        enabledTasks: tasks.filter((task) => task.enabled).length,
        nextRunAt: this.store.earliestNextRun(),
        lastRunAt,
      },
      now: Date.now(),
      runtime: {
        colo: this.store.getKv("runtime:colo"),
        locationHint: this.env.DO_LOCATION_HINT ?? null,
        nextPollAt: this.nextPollAt(),
        lastPollAt: Number(this.store.getKv("trigger:lastPoll") ?? 0) || null,
        lastTriggerEvent: this.store.getJson<{ at: number; ok: boolean; message: string } | null>(
          "trigger:lastEvent",
          null,
        ),
        pollSeconds: settings.pollSeconds,
      },
    };
  }
}

function sanitizeSettings(patch: Partial<Settings>): Partial<Settings> {
  const clean: Partial<Settings> = {};
  if (patch.timezone !== undefined) {
    const tz = Number(patch.timezone);
    if (Number.isFinite(tz) && tz >= -12 && tz <= 14) clean.timezone = tz;
  }
  if (patch.pollSeconds !== undefined) {
    const poll = Number(patch.pollSeconds);
    if (Number.isFinite(poll)) clean.pollSeconds = Math.max(15, Math.min(3600, Math.round(poll)));
  }
  if (patch.triggerEnabled !== undefined) clean.triggerEnabled = !!patch.triggerEnabled;
  if (patch.controlChat !== undefined) clean.controlChat = String(patch.controlChat).trim() || "self";
  if (patch.adminUserId !== undefined) clean.adminUserId = String(patch.adminUserId).trim();
  if (patch.defaultTarget !== undefined) clean.defaultTarget = String(patch.defaultTarget).trim();
  if (patch.stepPollSeconds !== undefined) {
    const value = Number(patch.stepPollSeconds);
    if (Number.isFinite(value)) clean.stepPollSeconds = Math.max(1, Math.min(30, value));
  }
  if (patch.turnstileSiteKey !== undefined) {
    clean.turnstileSiteKey = String(patch.turnstileSiteKey).trim().slice(0, 200);
  }
  if (patch.turnstileSecretKey !== undefined) {
    const secret = String(patch.turnstileSecretKey).trim().slice(0, 200);
    // 空字符串表示"保持不变"，要清除请用 clearTurnstileSecret
    if (secret) clean.turnstileSecretKey = secret;
  }
  if (patch.stepWaitSeconds !== undefined) {
    const value = Number(patch.stepWaitSeconds);
    if (Number.isFinite(value)) clean.stepWaitSeconds = Math.max(5, Math.min(300, value));
  }
  return clean;
}

const MAX_NAME = 80;
const MAX_HANDLE = 80;
const MAX_STEP_TEXT = 500;
const MAX_KEYWORDS = 20;

/** 对外输出设置时，把敏感字段换成布尔标记 */
export function redactSettings(settings: Settings): Settings {
  return {
    ...settings,
    turnstileSecretKey: "",
    turnstileSecretConfigured: Boolean(settings.turnstileSecretKey),
  };
}

function clampText(value: unknown, max: number): string {
  return String(value ?? "").slice(0, max);
}

function normalizeTarget(input: TaskInput | Task): Target {
  const kind = input.target?.kind;
  const safeKind = kind === "channel" || kind === "chat" || kind === "user" ? kind : "user";
  return {
    kind: safeKind,
    id: clampText(input.target?.id, MAX_HANDLE).trim(),
    title: input.target?.title ? clampText(input.target.title, MAX_HANDLE) : undefined,
    username: input.target?.username ? clampText(input.target.username, MAX_HANDLE) : undefined,
    accessHash: input.target?.accessHash ? clampText(input.target.accessHash, 32) : undefined,
  };
}

function normalizeTaskInput(input: TaskInput | Task): TaskInput {
  const schedule = { ...input.schedule };
  if (schedule.kind === "daily" || schedule.kind === "window" || schedule.kind === "once") {
    schedule.time = schedule.time || "09:00";
  }
  if (schedule.kind === "window" && !schedule.windowEnd) schedule.windowEnd = schedule.time ?? "10:00";
  if (schedule.kind === "interval") schedule.intervalMinutes = Math.max(1, Number(schedule.intervalMinutes ?? 60));
  schedule.jitterSeconds = Math.max(0, Math.min(3600, Number(schedule.jitterSeconds ?? 0)));

  const steps = (input.steps ?? [])
    .slice(0, 20)
    .map((step) => {
      if (step.type === "wait") {
        return { type: "wait" as const, seconds: Math.max(0, Math.min(600, Number(step.seconds ?? 3) || 0)) };
      }
      if (step.type === "random") {
        return {
          type: "random" as const,
          options: (step.options ?? []).slice(0, 10).map((item) => clampText(item, MAX_STEP_TEXT)).filter(Boolean),
        };
      }
      if (step.type === "click") {
        return {
          ...step,
          text: clampText(step.text, MAX_STEP_TEXT),
          row: Number.isFinite(Number(step.row)) ? Math.max(0, Math.min(50, Number(step.row))) : undefined,
          column: Number.isFinite(Number(step.column)) ? Math.max(0, Math.min(50, Number(step.column))) : undefined,
        };
      }
      if (step.type === "number") return { type: "number" as const, value: clampText(step.value, 20) };
      return { type: "text" as const, text: clampText(step.text, MAX_STEP_TEXT) };
    })
    .filter((step) => {
      if (step.type === "text") return !!step.text;
      if (step.type === "random") return (step.options ?? []).length > 0;
      if (step.type === "number") return !!step.value;
      return true;
    });

  const threadId = Number(input.threadId);

  return {
    name: clampText(input.name, MAX_NAME).trim() || "未命名任务",
    enabled: input.enabled !== false,
    target: normalizeTarget(input),
    threadId: Number.isFinite(threadId) && threadId > 0 ? threadId : null,
    schedule,
    steps,
    successKeywords: (input.successKeywords ?? [])
      .slice(0, MAX_KEYWORDS)
      .map((keyword) => clampText(keyword, 60).trim())
      .filter(Boolean),
    timeoutSeconds: Math.max(5, Math.min(120, Number(input.timeoutSeconds ?? 30))),
    stepDelaySeconds: Math.max(0, Math.min(60, Number(input.stepDelaySeconds ?? 3))),
    deleteAfterSeconds: Math.max(0, Math.min(3600, Number(input.deleteAfterSeconds ?? 0))),
    cleanupPrevious: !!input.cleanupPrevious,
    source: input.source ?? "ui",
    nextRunAt: input.nextRunAt ?? null,
    lastRunAt: input.lastRunAt ?? null,
    lastResult: input.lastResult ?? null,
    lastMessage: input.lastMessage ?? null,
  };
}

const WELCOME_TEXT = `👋 签到台已就绪

往这里转发/分享要签到的机器人，再发一条配置就能建任务，例如：
9.30 签到
9.30 签到 btn:立即签到 #kw:签到成功
8.30-9.30 rand:早上好|午安

发「列表」看任务，发「帮助」看完整语法。`;

const HELP_TEXT = `💡 触发语法：[时间] [动作...]

时间：9.30 / 09:30 / 0930；窗口 9.30-10.30；间隔 每30分 / 每2小时
动作：
 · 直接写文本 → 发送该文本（含空格用引号）
 · btn:按钮文本 → 点击按钮；btn:0,1 → 按行列点击
 · num:1 → 直接发数字（数字选择类机器人）
 · wait:5 → 等待 5 秒
 · rand:早安|晚上好|午安 → 随机挑一条发送
修饰：#kw:签到成功|已签到  #jitter:120  #once  #delete:30  #timeout:40  #delay:3  #thread:12  #name:名称
（每个动作之间默认间隔 3 秒，用 #delay:0 可关掉
运行细节（每步、按钮列表、机器人回应）在「任务 → 最近结果 → 步骤日志」里）
目标：@机器人 / @群组 / t.me 链接 / 到:-100xxx，或把消息转发/分享到收藏夹（先转发再发配置也认，30 分钟内有效）
群组：@here = 发到当前这个群（在群里发配置时最省事）

示例：
9.30 签到
9.30 签到 btn:立即签到 #kw:签到成功
8.30-9.30 参与 rand:早上好|午安
每2小时 打卡

管理命令：列表 / 立即 <编号> / 开启 <编号> / 关闭 <编号> / 删除 <编号> / 帮助`;
