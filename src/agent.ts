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
import type { AccountInfo, AgentState, LogEntry, LogSource, Settings, Target, Task, TaskInput } from "./types";
import { buildDigest, countTasks, failedTaskNames, nextDigestAt, shouldSendDigest } from "./notify/digest";
import { NOTIFY_EVENTS, isNotifyEventId, isThrottledEvent, normalizeNotifyEvents } from "./notify/events";
import type { NotifyEventId } from "./notify/events";
import { buildWebhookPayload, detectWebhookKind, parseWebhookResult } from "./notify/webhook";
import { createTgClient, createTgClientOnDc, errorMessage, isConnectionError, migrateDcFromError } from "./telegram/client";
import { executeTask, resolveEntity, type ExecHooks } from "./telegram/executor";
import { computeNextRun, formatInTimezone, localDayElapsedMs } from "./schedule/time";
import { decideRun, shouldAutoPause } from "./schedule/guard";
import { taskToCommand } from "./schedule/command";
import {
  defaultName,
  findTimeToken,
  parseTrigger,
  renameForTarget,
  stripTriggerPrefix,
  tokenize,
  type TriggerContext,
} from "./schedule/dsl";
import { messageTargetHint, usernameFromLink, type MessageLike, type MessageTargetHint } from "./telegram/targets";
import type { Env } from "./env";
import { bucketDaily } from "./events";
import { applyTargetPatch, normalizeTaskInput, taskFingerprint, taskToExport } from "./task";
import { redactSettings, shouldAutoFillAdminId } from "./settings";

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
/** 触发消息单批拉取条数 / 最多回溯几批（多了会拖慢轮询，少了会丢指令） */
const TRIGGER_FETCH_BATCH = 100;
const TRIGGER_FETCH_BATCHES = 5;
/** run-all 每次处理的批大小：8 个任务 × 单任务预算，仍在网关超时以内 */
const RUN_ALL_BATCH = 8;
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
/** 按消息 id 去重（分批拉取时相邻批次可能重叠） */
function dedupeById<T extends { id: number }>(items: T[]): T[] {
  const seen = new Map<number, T>();
  for (const item of items) if (!seen.has(item.id)) seen.set(item.id, item);
  return [...seen.values()];
}

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
      if (path === "/state" && method === "GET") return json(this.buildState());
      if (path === "/settings" && method === "POST") {
        const body = (await request.json()) as Partial<Settings> & {
          clearTurnstileSecret?: boolean;
          clearNotifyWebhookSecret?: boolean;
        };
        const { clearTurnstileSecret, clearNotifyWebhookSecret, ...rest } = body;
        const patch: Partial<Settings> = { ...rest };
        if (clearTurnstileSecret) patch.turnstileSecretKey = "";
        const before = this.store.getSettings();
        const saved = this.store.saveSettings(sanitizeSettings(patch));
        if (clearTurnstileSecret) this.store.saveSettings({ turnstileSecretKey: "" });
        if (clearNotifyWebhookSecret) this.store.saveSettings({ notifyWebhookSecret: "" });
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
      if (path === "/tasks/export" && method === "GET") {
        const tasks = this.store.listTasks().map(taskToExport);
        return json({
          format: "cf-tg-checkin.tasks",
          version: 1,
          exportedAt: Date.now(),
          tasks,
        });
      }

      if (path === "/tasks/import" && method === "POST") {
        const body = (await request.json()) as { tasks?: TaskInput[] };
        const incoming = Array.isArray(body.tasks) ? body.tasks.slice(0, 200) : [];
        if (!incoming.length) return jsonError("没有可导入的任务", 400);

        const created: number[] = [];
        const skipped: Array<{ name: string; reason: string }> = [];
        for (const item of incoming) {
          try {
            const result = this.createTask(item);
            if (result.created) created.push(result.task.id);
            else skipped.push({ name: item.name ?? "未命名", reason: `已存在相同任务 #${result.task.id}` });
          } catch (error) {
            skipped.push({ name: item.name ?? "未命名", reason: errorMessage(error) });
          }
        }
        await this.scheduleNextAlarm();
        return json({ ok: true, created: created.length, ids: created, skipped });
      }

      if (path === "/tasks/run-all" && method === "POST") {
        // 一次跑太多会撞网关超时（前端看到 524、其实任务还在跑）：
        // 每次只处理一批，把剩余数量返回给前端，由前端接着调。
        const limit = intParam(url.searchParams.get("limit"), RUN_ALL_BATCH, 1, 50);
        const offset = intParam(url.searchParams.get("offset"), 0, 0, 10_000);
        const result = await this.serialize(() => this.runAllTasksBatch(offset, limit));
        await this.scheduleNextAlarm();
        return json(result);
      }

      const taskMatch = /^\/tasks\/(\d+)(\/run|\/logs|\/command)?$/.exec(path);
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
        if (suffix === "/command" && method === "GET") {
          const settings = this.store.getSettings();
          return json({ command: taskToCommand(task, settings.triggerPrefix ?? "") });
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
        const pageSize = intParam(url.searchParams.get("pageSize") ?? url.searchParams.get("limit"), 20, 1, 100);
        const level = url.searchParams.get("level");
        const taskIdParam = intParam(url.searchParams.get("taskId"), 0, 0, Number.MAX_SAFE_INTEGER) || null;
        const query = url.searchParams.get("q");
        const beforeId = intParam(url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER) || null;
        const sinceHours = intParam(url.searchParams.get("sinceHours"), 0, 0, 24 * 365);
        const since = sinceHours > 0 ? Date.now() - sinceHours * 3600 * 1000 : null;

        const filter = { limit: pageSize, beforeId, level, taskId: taskIdParam, query, since };
        const total = this.store.countLogs(filter);
        const pages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(pages, intParam(url.searchParams.get("page"), 1, 1, 100_000));

        const logs = this.store.listLogs({ ...filter, offset: (page - 1) * pageSize });
        return json({
          logs,
          total,
          page,
          pageSize,
          pages,
          // 游标模式下仍然返回（兼容旧调用）
          nextBefore: beforeId && logs.length === pageSize ? logs[logs.length - 1].id : null,
        });
      }
      if (path === "/notify/event" && method === "POST") {
        // 只给 Worker 内部调用（登录失败发生在 Worker 侧，那里拿不到 Telegram client）
        if (request.headers.get("x-internal-call") !== "notify") return jsonError("仅限内部调用", 403);
        const body = (await request.json()) as { type?: string; detail?: string };
        if (!isNotifyEventId(body.type)) return jsonError("未知通知类型", 400);
        await this.notifyEvent(null, body.type, {
          title: body.type === "login_failed" ? "🔒 管理界面登录被暂时锁定" : "通知",
          text: String(body.detail ?? "").slice(0, 300),
        });
        return json({ ok: true });
      }

      if (path === "/events" && method === "POST") {
        const body = (await request.json()) as { name?: string };
        const allowed = new Set(["failure_handled", "template_used", "command_copied"]);
        const name = String(body.name ?? "");
        if (!allowed.has(name)) return jsonError("未知事件", 400);
        this.store.recordEvent(name);
        return json({ ok: true });
      }

      if (path === "/logs/clear" && method === "POST") {
        this.store.clearLogs();
        return json({ ok: true });
      }

      if (path === "/auth/turnstile" && method === "GET") {
        // 这个接口会回传 Turnstile 的 secret，只给 Worker 内部用：
        // proxyToAgent 会重建请求头（只带 content-type / x-cf-colo），外部请求塞不进这个标记
        if (request.headers.get("x-internal-call") !== "turnstile") {
          return jsonError("仅限内部调用", 403);
        }
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

      if (path === "/command" && method === "POST") {
        const body = (await request.json()) as TaskInput;
        const settings = this.store.getSettings();
        const normalized = normalizeTaskInput({ ...body, name: body.name ?? "" });
        return json({ command: taskToCommand(normalized, settings.triggerPrefix ?? "") });
      }

      if (path === "/trigger/parse" && method === "POST") {
        const body = (await request.json()) as { text?: string };
        const settings = this.store.getSettings();
        const ctx: TriggerContext = { defaultTarget: settings.defaultTarget || undefined, allowMissingTarget: true };
        const rawText = String(body.text ?? "");
        const prefix = (settings.triggerPrefix ?? "").trim();
        let parseText = rawText;
        if (prefix) {
          const stripped = stripTriggerPrefix(rawText, prefix);
          if (!stripped.matched) {
            return json({
              ok: false,
              error: `消息需要以触发前缀「${prefix}」开头，例如：${prefix} ${rawText.slice(0, 60)}`,
            });
          }
          parseText = stripped.rest;
        }
        const parsed = parseTrigger(parseText, ctx);
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

    const digestAt = this.nextDigestAtMs(settings);
    if (digestAt) candidates.push(digestAt);

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

  /** 下一次日报时间（没开启日报就是 null） */
  private nextDigestAtMs(settings: Settings): number | null {
    if (!(settings.notifyEvents ?? []).includes("daily_digest")) return null;
    const now = Date.now();
    return nextDigestAt(settings.digestHour ?? 22, 0, now, settings.timezone ?? 8);
  }

  /**
   * 到点就发当天日报：统计来自事件计数，失败任务名来自日志。
   * 用 kv 里的 lastSentAt 保证一天只发一次（alarm 可能一小时内被唤醒很多次）。
   */
  private async maybeSendDigest(now: number): Promise<void> {
    const settings = this.store.getSettings();
    if (!(settings.notifyEvents ?? []).includes("daily_digest")) return;

    const lastSentAt = Number(this.store.getKv("notify:digest:lastAt") ?? 0) || null;
    const due = shouldSendDigest({
      now,
      hour: settings.digestHour ?? 22,
      minute: 0,
      timezone: settings.timezone ?? 8,
      lastSentAt,
    });
    if (!due) return;

    // 一个通道都没配就别假装发了（也不写 lastAt，配好后当天还能补发）
    const hasTelegram = settings.notifyOnFailure !== false && Boolean(this.store.getKv(KV_SESSION));
    const hasWebhook = Boolean((settings.notifyWebhook ?? "").trim());
    if (!hasTelegram && !hasWebhook) return;

    this.store.setKv("notify:digest:lastAt", String(now));
    try {
      const tasks = this.store.listTasks();
      const counts = countTasks(tasks);
      // 统计以日志为准：连接级失败不写 run_finished 事件，用事件计数会漏报
      const dayStart = now - localDayElapsedMs(now, settings.timezone ?? 8);
      const logs = this.store.listLogs({ limit: 500, since: dayStart });
      const runs = logs.filter((item) => item.source === "auto" || item.source === "manual");
      const bucket = {
        ok: runs.filter((item) => item.ok).length,
        fail: runs.filter((item) => !item.ok).length,
      };
      const content = buildDigest(
        {
          ok: bucket.ok,
          fail: bucket.fail,
          failedTasks: failedTaskNames(logs),
          totalTasks: counts.total,
          enabledTasks: counts.enabled,
          nextRunAt: this.store.earliestNextRun(),
          lastMessage: tasks.find((task) => task.lastMessage)?.lastMessage ?? null,
        },
        { timezone: settings.timezone ?? 8, now },
      );

      // 日报直接发给两个通道（不再走事件节流：一天本来就只发一次）
      if (hasTelegram) {
        try {
          await this.withClient((client) =>
            client.sendMessage("me" as never, { message: `${content.title}\n${content.text}`, parseMode: false }),
          );
        } catch {
          /* 发不出去就只发 webhook */
        }
      }
      await this.sendWebhook(settings, { title: content.title, text: content.text });
      this.store.addLog({
        taskId: null,
        taskName: null,
        at: now,
        ok: true,
        level: "info",
        message: "已发送日报",
        detail: `${content.title}\n${content.text}`,
        source: "system",
      });
    } catch (error) {
      this.store.addLog({
        taskId: null,
        taskName: null,
        at: now,
        ok: false,
        level: "warn",
        message: `日报发送失败：${errorMessage(error)}`,
        detail: null,
        source: "system",
      });
    }
  }

  private async tick(): Promise<LogEntry[]> {
    const now = Date.now();
    const settings = this.store.getSettings();
    // 日报不依赖 Telegram 连接，先处理掉（失败了也不影响调度）
    void this.maybeSendDigest(now);
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
                  source: "system",
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
                source: "system",
                detail: transient ? "已自动重连重试一次，仍失败" : null,
              });
            }
          }
        }
        if (due.length) {
          // 护栏：同一任务 45 秒内不重复执行（防止调度 bug / 窗口边界造成连发）
          const runnable: Task[] = [];
          for (const task of due) {
            const decision = decideRun(task, now, settings.timezone);
            if (!decision.run) {
              if (decision.reason !== "not-due") {
                this.store.addLog({
                  taskId: task.id,
                  taskName: task.name,
                  at: now,
                  ok: false,
                  level: "warn",
                  source: "system",
                  message:
                    decision.reason === "already-ran-today"
                      ? "跳过：今天已经执行过（每天类型任务一天只跑一次）"
                      : `跳过：${decision.detail ?? "刚执行过"}`,
                  detail: decision.detail ?? null,
                });
                if (decision.nextRunAt) this.store.setTaskNextRun(task.id, decision.nextRunAt);
              }
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
        source: "system",
        detail: logs.join("\n") || null,
      });
      // 连不上 / 会话过期会导致整批任务都跑不了，单独推一条
      await this.notifyConnectionProblem(null, errorMessage(error));
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
          // 复用的连接可能已经半死：丢掉它，重连一次再试。
          // 业务错误（目标不存在 / 参数不合法）不重试 —— 否则会把副作用重放一遍。
          if (!isConnectionError(error)) throw error;
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

  /**
   * 管理员 ID 默认 = 当前登录的 Telegram 账号。
   * 只在「从没设置过」时填一次（用 kv 标记），用户日后手动清空不会被覆盖。
   */
  private applyDefaultAdminId(meId: string): void {
    const settings = this.store.getSettings();
    const should = shouldAutoFillAdminId({
      adminUserId: settings.adminUserId,
      meId,
      alreadyAutoFilled: Boolean(this.store.getKv("adminId:autoFilled")),
    });
    if (!should) return;
    this.store.saveSettings({ adminUserId: String(meId) });
    this.store.setKv("adminId:autoFilled", "1");
    this.store.addLog({
      taskId: null,
      taskName: null,
      at: Date.now(),
      ok: true,
      level: "info",
      message: `管理员 ID 已设为当前账号（${meId}）`,
      source: "system",
      detail: "只有这个账号发出的消息指令会生效；可在设置里修改。",
    });
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

    // 一次只取最近 20 条会在「短时间内发很多指令」时静默丢消息：
    // 游标直接跳到最高 id，中间那些没被看到的就再也不会被处理了。
    // 这里按批往回翻，直到取够 5 批（500 条）或已经翻到游标之前。
    const batchSize = TRIGGER_FETCH_BATCH;
    const collected: Api.Message[] = [];
    let offsetId = 0;
    for (let batch = 0; batch < TRIGGER_FETCH_BATCHES; batch += 1) {
      const page = (await client.getMessages(entity as never, {
        limit: batchSize,
        ...(offsetId ? { offsetId } : {}),
      })) as Api.Message[];
      if (!page.length) break;
      collected.push(...page);
      const lowest = Math.min(...page.map((message) => message.id));
      if (!cursor || lowest <= cursor) break;
      offsetId = lowest;
    }
    const messages = dedupeById(collected);
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
        source: "system",
        detail: `控制会话：${controlRef}\n如果刚刚发过配置，请再发一次。`,
      });
      const greetKey = `trigger:greeted:${controlRef}`;
      if (!this.store.getKv(greetKey)) {
        this.store.setKv(greetKey, "1");
        await client
          .sendMessage(entity as never, { message: welcomeText(settings.triggerPrefix ?? ""), parseMode: false })
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
        source: "system",
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
          source: "trigger",
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
        source: "trigger",
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

    // 可选前缀：设置后只有以它开头的消息才当配置解析，收藏夹里的随手笔记不会被误处理
    const prefix = (settings.triggerPrefix ?? "").trim();
    let messageText = text;
    if (prefix) {
      const stripped = stripTriggerPrefix(text, prefix);
      if (stripped.matched) {
        messageText = stripped.rest;
        trace.push(`命中前缀「${prefix}」，去掉后：${messageText.slice(0, 80)}`);
      } else {
        // 没前缀：只允许"纯转发/分享"用来登记目标，其余静默忽略
        const hinted = await this.inferTarget(client, entity, message);
        if (hinted) {
          this.store.setJson(KV_TRIGGER_TARGET, { target: hinted, at: Date.now() });
          trace.push(`未带前缀，但有可识别来源 → 登记目标：${JSON.stringify(hinted)}`);
          record(true, `登记目标（无前缀）：${hinted.title || (hinted.username ? `@${hinted.username}` : hinted.id)}`);
        } else if (findTimeToken(tokenize(text))) {
          trace.push(`看起来像配置但缺少前缀「${prefix}」→ 忽略`);
          record(false, `忽略：消息缺少触发前缀「${prefix}」`);
          // 只在"看起来像配置"时提醒，且 10 分钟最多一次，避免刷屏
          const lastHint = Number(this.store.getKv("trigger:prefixHintAt") ?? 0);
          if (Date.now() - lastHint > 10 * 60_000) {
            this.store.setKv("trigger:prefixHintAt", String(Date.now()));
            await client
              .sendMessage(entity as never, {
                message: `⚠️ 需要在开头加触发前缀「${prefix}」，例如：\n${prefix} ${text.slice(0, 120)}`,
                parseMode: false,
              })
              .catch(() => undefined);
          }
        }
        return;
      }
      if (!messageText) return;
    }

    // 这条消息自己指向谁（转发来源 / 联系人卡片 / 链接 / 回复的那条 / 最近的上一条）
    const hint = await this.inferTarget(client, entity, message);
    const hasTime = Boolean(findTimeToken(tokenize(messageText)));

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
      await reply(helpText(settings.triggerPrefix ?? ""));
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

    const parsed = parseTrigger(messageText, ctx);
    if (!parsed.ok) {
      trace.push(`解析失败：${parsed.error}`);
      record(false, `触发解析失败：${parsed.error}`);
      await reply(`⚠️ ${parsed.error}`);
      return;
    }

    const result = parsed.result;
    logs.push(`${result.kind}: ${messageText.slice(0, 60)}`);

    switch (result.kind) {
      case "help": {
        trace.push("命令：帮助");
        record(true, "触发器命令：帮助");
        await reply(helpText(settings.triggerPrefix ?? ""));
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
        await reply(helpText(settings.triggerPrefix ?? ""));
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
        source: "system",
        detail: "同一条触发配置发多次、或反复点保存，都会产生重复任务；这里直接复用已有的。",
      });
      return { task: duplicate, created: false };
    }

    const nextRunAt = normalized.enabled ? computeNextRun(normalized.schedule, now, settings.timezone) : null;
    this.store.recordEvent(`task_created:${normalized.source ?? "ui"}`);
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
      // 这时还没进到 runSingleTask，通知得在这里发，否则「手动执行失败」永远不通知
      await this.notifyConnectionProblem(null, message);
      return tasks.map((task) =>
        this.store.addLog({
          taskId: task.id,
          taskName: task.name,
          at: Date.now(),
          ok: false,
          level: "error",
          message,
          detail: null,
          source: options.manual ? "manual" : "auto",
        }),
      );
    }
  }

  /** 单次 run-all 最多跑几个任务（前端会分批调用） */
  private async runAllTasksBatch(
    offset: number,
    limit: number,
  ): Promise<{ ok: boolean; logs: LogEntry[]; processed: number; remaining: number; nextOffset: number }> {
    const tasks = this.store.listTasks().filter((task) => task.enabled);
    const batch = tasks.slice(offset, offset + limit);
    const logs = batch.length ? await this.runTasks(batch, undefined, { manual: true }) : [];
    const nextOffset = offset + batch.length;
    return {
      ok: logs.every((log) => log.ok),
      logs,
      processed: logs.length,
      remaining: Math.max(0, tasks.length - nextOffset),
      nextOffset,
    };
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
    index = 0,
  ): Promise<{ entity: Awaited<ReturnType<typeof resolveEntity>>; task: Task; target: Target }> {
    const targets = task.targets && task.targets.length > 1 ? task.targets : null;
    const current: Target = (targets ? targets[index] : undefined) ?? task.target;
    const entity = await resolveEntity(client, current);

    // 目标里缺 username / accessHash / 显示名时补一次，之后每次解析都能直接命中
    if (!current.username || !current.accessHash || !current.title) {
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
        ...current,
        id: peerId ? String(peerId) : current.id,
        username: current.username ?? anyEntity.username,
        title: current.title ?? displayName,
        ...(current.accessHash
          ? { accessHash: current.accessHash }
          : anyEntity.accessHash !== undefined && anyEntity.accessHash !== null
            ? { accessHash: String(anyEntity.accessHash) }
            : {}),
      };

      if (JSON.stringify(patch) !== JSON.stringify(current)) {
        // 只有主目标能改任务名；附加目标只回写自己那一格（否则会顶掉主目标）
        const renamed = applyTargetPatch(task, index, patch, {
          renameTo: renameForTarget(task.name, current, patch) || null,
        });
        const renameTo = renamed.name ?? null;

        const updated = this.store.updateTask(task.id, renamed, Date.now());
        this.store.addLog({
          taskId: task.id,
          taskName: renameTo ?? task.name,
          at: Date.now(),
          ok: true,
          level: "info",
          message: `目标已自动补全：${patch.title || (patch.username ? `@${patch.username}` : patch.id)}`,
          detail: renameTo ? `任务名同步更新为「${renameTo}」` : null,
          source: "system",
        });
        return { entity, task: updated ?? task, target: patch };
      }
    }

    return { entity, task, target: current };
  }

  private async runSingleTask(
    client: TelegramClient,
    task: Task,
    options: { manual?: boolean } = {},
  ): Promise<LogEntry> {
    const settings = this.store.getSettings();
    const sentKey = `task:${task.id}:sent`;
    const hooks: ExecHooks = { log: () => undefined };

    const triggerSource: LogSource = options.manual ? "manual" : "auto";
    const startedAt = Date.now();
    /** 跑之前的连续失败次数：判断这次是不是「恢复」 */
    const streakBefore = this.store.failStreakOf(task.id);
    let log: LogEntry;
    try {
      const settings = this.store.getSettings();
      const targets = task.targets && task.targets.length > 1 ? task.targets : [task.target];
      const outcomes: Array<{ target: Target; outcome: Awaited<ReturnType<typeof executeTask>> }> = [];

      for (const [index, target] of targets.entries()) {
        const prepared = await this.ensureTarget(client, task, index);
        const effective = prepared.target;
        const targetKey = (effective.username || effective.id || target.username || target.id || "").toLowerCase();
        const previousForTarget = this.store.getJson<number[]>(`${sentKey}:${targetKey}`, []);
        const outcome = await executeTask(client, { ...prepared.task, target: effective }, {
          previousSent: previousForTarget,
          hooks,
          entity: prepared.entity,
          pollIntervalMs: (settings.stepPollSeconds ?? 3) * 1000,
          stepWaitMs: (settings.stepWaitSeconds ?? 30) * 1000,
        });
        this.store.setJson(`${sentKey}:${targetKey}`, outcome.sent);
        if (task.deleteAfterSeconds > 0 && outcome.sent.length) {
          this.store.addDeletion(
            outcome.chatId ?? effective.id,
            outcome.sent,
            Date.now() + task.deleteAfterSeconds * 1000,
          );
        }
        outcomes.push({ target: effective, outcome });

        // 多目标时每个目标单独记一条日志，便于看出是哪个群失败
        if (targets.length > 1) {
          const label = effective.username ? `@${effective.username}` : effective.title || effective.id;
          this.store.addLog({
            taskId: task.id,
            taskName: `${task.name} → ${label}`,
            at: Date.now(),
            ok: outcome.ok,
            level: outcome.ok ? "info" : "warn",
            message: outcome.message,
            detail: outcome.detail || null,
            source: triggerSource,
            durationMs: Date.now() - startedAt,
          });
        }
      }

      const passed = outcomes.filter((item) => item.outcome.ok).length;
      const firstOk = outcomes.find((item) => item.outcome.ok);
      const outcome = {
        ok: passed > 0,
        message:
          targets.length > 1
            ? `${passed}/${targets.length} 个目标成功` + (firstOk ? `（例：${firstOk.outcome.message}）` : "")
            : outcomes[0].outcome.message,
        detail: outcomes
          .map((item) => `▶ ${item.target.username || item.target.id}\n${item.outcome.detail}`)
          .join("\n\n"),
        sent: outcomes.flatMap((item) => item.outcome.sent),
        chatId: outcomes[0].outcome.chatId,
      };

      this.store.setJson(sentKey, outcome.sent);
      this.store.recordRun(task.id, outcome.ok ? "ok" : "fail", outcome.message, outcome.detail || null, Date.now());
      log = this.store.addLog({
        taskId: task.id,
        taskName: task.name,
        at: Date.now(),
        ok: outcome.ok,
        level: outcome.ok ? "info" : "warn",
        message: outcome.message,
        detail: outcome.detail || null,
        source: triggerSource,
        durationMs: Date.now() - startedAt,
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
        source: triggerSource,
        durationMs: Date.now() - startedAt,
      });
    }

    if (log) this.store.recordEvent(`run_finished:${log.ok ? "ok" : "fail"}`);

    // 连续失败到阈值 → 自动暂停（避免天天失败还一直跑）
    const streak = this.store.failStreakOf(task.id);
    if (log && !log.ok && shouldAutoPause(streak)) {
      this.store.updateTask(task.id, { enabled: false, nextRunAt: null }, Date.now());
      this.store.addLog({
        taskId: task.id,
        taskName: task.name,
        at: Date.now(),
        ok: false,
        level: "error",
        message: `已自动暂停：连续失败 ${streak} 次`,
        detail: "排查后到任务详情里重新启用；可在设置里关掉失败提醒。",
        source: "system",
      });
      await this.notifyEvent(client, "auto_paused", {
        title: `⏸ 任务「${task.name}」已自动暂停`,
        text: `连续失败 ${streak} 次，已停用该任务。\n原因：${(log.message || "执行失败").slice(0, 200)}`,
        task,
      });
    } else if (log && !log.ok) {
      const reason = log.message || "执行失败";
      const type = this.classifyRunFailure(reason);
      // 连接/会话类错误不按「任务失败」发，避免每个任务各发一条
      if (type === "connection_error" || type === "session_expired") {
        await this.notifyConnectionProblem(client, reason);
      } else {
        await this.notifyEvent(client, "run_failed", {
          title: `⚠️ 任务「${task.name}」执行失败`,
          text: reason.slice(0, 300),
          task,
        });
      }
    } else if (log && log.ok) {
      if (streakBefore >= 1) {
        await this.notifyEvent(client, "run_recovered", {
          title: `✅ 任务「${task.name}」恢复正常`,
          text: `之前连续失败 ${streakBefore} 次，这次执行成功。`,
          task,
        });
      }
      await this.notifyEvent(client, "run_success", {
        title: `✅ 任务「${task.name}」执行成功`,
        text: log.message || "执行完成",
        task,
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

  /**
   * 失败提醒：默认给自己发一条 Telegram 私聊（同一任务 1 小时最多一次），
   * 另外可选 POST 到自定义 Webhook。
   */
  /**
   * 事件通知的统一入口。
   *
   * - 事件类型由设置里的 notifyEvents 多选决定
   * - 两个通道：Telegram 私聊（notifyOnFailure）与 Webhook（配了地址才发）
   * - 带 throttled 的事件按「事件 + 任务」1 小时节流，避免刷屏
   */
  private async notifyEvent(
    client: TelegramClient | null,
    type: NotifyEventId,
    payload: { title: string; text: string; task?: Task | null },
  ): Promise<void> {
    const settings = this.store.getSettings();
    const selected = settings.notifyEvents ?? [];
    if (!selected.includes(type)) return;

    const throttleKey = `notify:${type}:${payload.task?.id ?? "global"}:at`;
    if (isThrottledEvent(type)) {
      const last = Number(this.store.getKv(throttleKey) ?? 0);
      if (Date.now() - last < 60 * 60_000) return;
    }
    this.store.setKv(throttleKey, String(Date.now()));

    const text = `${payload.title}\n${payload.text}\n时间：${formatInTimezone(Date.now(), settings.timezone)}`;

    if (settings.notifyOnFailure !== false && client) {
      try {
        await client.sendMessage("me" as never, { message: text, parseMode: false });
      } catch {
        /* 自己给自己发也可能失败（被限流等），不影响主流程 */
      }
    }

    await this.sendWebhook(settings, {
      taskId: payload.task?.id ?? null,
      taskName: payload.task?.name ?? null,
      title: payload.title,
      text: payload.text,
    });
  }

  /** 连不上 / 会话过期：这两类要区分开，处理方式不一样 */
  private classifyRunFailure(reason: string): NotifyEventId {
    return /AUTH_KEY|SESSION_(REVOKED|EXPIRED)|USER_DEACTIVATED|AUTH_KEY_UNREGISTERED/i.test(reason)
      ? "session_expired"
      : "connection_error";
  }

  /** 整批跑不动时的提醒（独立于按任务的节流，见 notifyEvent 的 throttled） */
  private async notifyConnectionProblem(client: TelegramClient | null, reason: string): Promise<void> {
    const type = this.classifyRunFailure(reason);
    await this.notifyEvent(client, type, {
      title: type === "session_expired" ? "⚠️ Telegram 登录已失效" : "⚠️ 签到台连不上 Telegram",
      text:
        (type === "session_expired"
          ? "会话被注销或过期，所有任务都不会执行。请到「账号」页重新登录。"
          : "所有到期任务都没能执行，通常是网络/机房问题，稍后会自动重试。") + `\n原因：${reason.slice(0, 200)}`,
    });
  }

  /**
   * 推送一条 Webhook 消息。
   *
   * 渠道由设置里手动选择（钉钉 / 企业微信 / 飞书 / 通用 JSON）；
   * 这些平台**出错也返回 HTTP 200**，所以必须解析 body 里的 errcode/code，
   * 失败要落日志，否则「消息没到」会被当成推送成功。
   */
  private async sendWebhook(
    settings: Settings,
    message: { taskId?: number | null; taskName?: string | null; title: string; text: string },
  ): Promise<boolean> {
    const webhook = (settings.notifyWebhook ?? "").trim();
    if (!webhook || !/^https?:\/\//i.test(webhook)) return false;

    // 老配置没有渠道字段时按域名兜底猜一次
    const kind = settings.notifyWebhookKind ?? detectWebhookKind(webhook);
    const now = Date.now();
    try {
      const payload = await buildWebhookPayload(
        webhook,
        settings.notifyWebhookSecret ?? "",
        {
          ...message,
          text: `${message.text}\n时间：${formatInTimezone(now, settings.timezone)}`,
          at: now,
        },
        { kind, now },
      );
      const response = await fetch(payload.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload.body,
        signal: AbortSignal.timeout(8000),
      });
      const body = await response.text().catch(() => "");
      const result = parseWebhookResult(payload.kind, response.status, body);
      if (!result.ok) {
        this.store.addLog({
          taskId: message.taskId ?? null,
          taskName: message.taskName ?? null,
          at: now,
          ok: false,
          level: "warn",
          message: `Webhook 推送失败（${payload.kind}）：${result.error}`,
          detail: "检查地址、加签密钥是否正确；钉钉的加签密钥只存服务端，留空保存表示不修改。",
          source: "system",
        });
      }
      return result.ok;
    } catch (error) {
      this.store.addLog({
        taskId: message.taskId ?? null,
        taskName: message.taskName ?? null,
        at: now,
        ok: false,
        level: "warn",
        message: `Webhook 推送失败（${kind}）：${errorMessage(error)}`,
        detail: null,
        source: "system",
      });
      return false;
    }
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

  /**
   * 近 7 天执行趋势。前端每 30 秒拉一次 state，没必要每次都扫一遍事件表 —— 缓存 60 秒。
   */
  private usageTrend(tzHours: number): Array<{ date: string; ok: number; fail: number }> {
    const cached = this.store.getJson<{ at: number; tz: number; data: Array<{ date: string; ok: number; fail: number }> } | null>(
      "cache:usageTrend",
      null,
    );
    const now = Date.now();
    if (cached && cached.tz === tzHours && now - cached.at < 60_000) return cached.data;

    const data = bucketDaily(
      this.store
        .listEventSamples("run_finished:", now - 8 * 86400 * 1000)
        .map((row) => ({ ok: row.name === "run_finished:ok", at: row.at })),
      { now, tzHours, days: 7 },
    );
    this.store.setJson("cache:usageTrend", { at: now, tz: tzHours, data });
    return data;
  }

  private buildState(): AgentState {
    let settings = this.store.getSettings();
    const tasks = this.store.listTasks();
    const me = this.store.getJson<AccountInfo["me"]>(KV_ME, null);
    const creds = this.credentials();
    const pending = this.store.getJson<PendingLogin | null>(KV_PENDING, null);

    // 老部署补一次：管理员 ID 默认 = 当前登录账号
    if (me?.id) {
      this.applyDefaultAdminId(me.id);
      settings = this.store.getSettings();
    }

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
      events: {
        firstLoginAt: this.store.firstEventAt("first_login"),
        tasksCreated: {
          ui: this.store.countEvent("task_created:ui"),
          trigger: this.store.countEvent("task_created:trigger"),
        },
        runs: {
          ok: this.store.countEvent("run_finished:ok"),
          fail: this.store.countEvent("run_finished:fail"),
        },
        failureHandled: this.store.countEvent("failure_handled"),
        trend: this.usageTrend(settings.timezone ?? 8),
      },
      notifyCatalog: NOTIFY_EVENTS.map((item) => ({
        id: item.id,
        label: item.label,
        hint: item.hint,
        throttled: Boolean(item.throttled),
      })),
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
  if (patch.notifyOnFailure !== undefined) clean.notifyOnFailure = !!patch.notifyOnFailure;
  if (patch.notifyEvents !== undefined) clean.notifyEvents = normalizeNotifyEvents(patch.notifyEvents);
  if (patch.digestHour !== undefined) {
    const hour = Number(patch.digestHour);
    if (Number.isFinite(hour)) clean.digestHour = Math.max(0, Math.min(23, Math.round(hour)));
  }
  if (patch.notifyWebhook !== undefined) {
    clean.notifyWebhook = String(patch.notifyWebhook).trim().slice(0, 300);
  }
  if (patch.notifyWebhookKind !== undefined) {
    const kinds = ["generic", "dingtalk", "wecom", "feishu"];
    if (kinds.includes(String(patch.notifyWebhookKind))) {
      clean.notifyWebhookKind = patch.notifyWebhookKind;
    }
  }
  if (patch.notifyWebhookSecret !== undefined) {
    const secret = String(patch.notifyWebhookSecret).trim().slice(0, 200);
    // 空字符串表示"保持不变"，要清除请用 clearNotifyWebhookSecret
    if (secret) clean.notifyWebhookSecret = secret;
  }
  if (patch.triggerPrefix !== undefined) {
    clean.triggerPrefix = String(patch.triggerPrefix).trim().slice(0, 20);
  }
  if (patch.templates !== undefined) {
    const list = Array.isArray(patch.templates) ? patch.templates.slice(0, 20) : [];
    clean.templates = list
      .map((item, index) => ({
        id: String(item?.id || `t${Date.now()}${index}`).slice(0, 40),
        name: String(item?.name || "未命名模板").trim().slice(0, 20),
        command: String(item?.command || "").trim().slice(0, 500),
      }))
      .filter((item) => item.command);
  }
  return clean;
}


/** 对外输出设置时，把敏感字段换成布尔标记 */

function welcomeText(prefix: string): string {
  const p = prefix ? `${prefix} ` : "";
  return `👋 签到台已就绪

往这里转发/分享要签到的机器人，再发一条配置就能建任务${
    prefix ? `（每条配置都要以「${prefix}」开头）` : ""
  }，例如：
${p}9.30 签到
${p}9.30 签到 btn:立即签到 #kw:签到成功
${p}8.30-9.30 rand:早上好|午安

${p}列表 看任务，${p}帮助 看完整语法。`;
}

function helpText(prefix: string): string {
  const head = prefix
    ? `💡 每条配置都要以「${prefix}」开头，例如：${prefix} 9.30 签到\n`
    : "";
  return head + HELP_BODY;
}

const HELP_BODY = `💡 触发语法：[时间] [动作...]

时间：9.30 / 09:30 / 0930；窗口 9.30-10.30；间隔 每30分 / 每2小时
动作：
 · 直接写文本 → 发送该文本（含空格用引号）
 · btn:按钮文本 → 点击按钮；btn:0,1 → 按行列点击
 · num:1 → 直接发数字（数字选择类机器人）
 · wait:5 → 等待 5 秒
 · rand:早安|晚上好|午安 → 随机挑一条发送
修饰：#kw:签到成功|已签到  #jitter:120  #once  #delete:30  #timeout:40  #delay:3  #thread:12  #name:名称  #keep（保留上次发的消息，默认会删）
（每个动作之间默认间隔 3 秒，用 #delay:0 可关掉
运行细节（每步、按钮列表、机器人回应）在「任务 → 最近结果 → 步骤日志」里）
目标：@机器人 / @群组 / t.me 链接 / 到:-100xxx，或把消息转发/分享到收藏夹（先转发再发配置也认，30 分钟内有效）
群组：@here = 发到当前这个群（在群里发配置时最省事）

示例：
9.30 签到
9.30 签到 btn:立即签到 #kw:签到成功
8.30-9.30 参与 rand:早上好|午安
每2小时 打卡

管理命令：列表 / 立即 <编号> / 开启 <编号> / 关闭 <编号> / 删除 <编号> / 帮助

提示：如果在设置里配了「触发前缀」（例如 tg），所有配置都要以它开头，如「tg 9.30 签到」。`;

