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
import { computeNextRun, formatInTimezone } from "./schedule/time";
import { parseTrigger, type TriggerContext } from "./schedule/dsl";
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

const REPLY_MARKERS = ["✅", "❌", "⚠️", "📋", "💡", "⚙️", "🔧", "📝", "🚀", "⏰", "🗑️"];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function jsonError(error: unknown, status = 400): Response {
  return json({ error: errorMessage(error) }, status);
}

function isOwnReply(text: string): boolean {
  const trimmed = text.trimStart();
  return REPLY_MARKERS.some((marker) => trimmed.startsWith(marker));
}

export class TgAgent implements DurableObject {
  private readonly store: Store;
  private queue: Promise<unknown> = Promise.resolve();

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
      if (path === "/state" && method === "GET") return json(await this.buildState());
      if (path === "/settings" && method === "POST") {
        const patch = (await request.json()) as Partial<Settings>;
        const before = this.store.getSettings();
        const settings = this.store.saveSettings(sanitizeSettings(patch));
        if (before.controlChat !== settings.controlChat) this.resetTriggerCursor();
        if (before.triggerEnabled !== settings.triggerEnabled) await this.scheduleNextAlarm();
        return json({ settings });
      }

      if (path === "/tasks" && method === "POST") {
        const body = (await request.json()) as TaskInput;
        const task = this.createTask(body);
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
          const log = await this.serialize(() => this.runTasks([task]));
          await this.scheduleNextAlarm();
          return json({ ok: log[0]?.ok ?? false, log: log[0] });
        }
        if (suffix === "/logs" && method === "GET") {
          const limit = Number(url.searchParams.get("limit") ?? 20);
          return json({ logs: this.store.listLogs(limit, id) });
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
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return json({ logs: this.store.listLogs(limit) });
      }
      if (path === "/logs/clear" && method === "POST") {
        this.store.clearLogs();
        return json({ ok: true });
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
        const preview: Task = {
          ...result.task,
          id: 0,
          nextRunAt: computeNextRun(result.task.schedule, now, settings.timezone),
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
          try {
            await this.pollTriggers(client, logs);
          } catch (error) {
            logs.push(`触发器轮询失败：${errorMessage(error)}`);
            this.store.addLog({
              taskId: null,
              taskName: null,
              at: Date.now(),
              ok: false,
              level: "warn",
              message: `触发器轮询失败：${errorMessage(error)}`,
              detail: null,
            });
          }
        }
        if (due.length) {
          ran.push(...(await this.runTasks(due, client)));
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
  private async withClient<T>(fn: (client: TelegramClient) => Promise<T>): Promise<T> {
    const creds = this.requireCredentials();
    if (!creds.session) throw new Error("还没登录 Telegram");
    const client = createTgClient(creds);
    try {
      await client.connect();
      const result = await fn(client);
      this.persistSession(client);
      this.store.deleteKv(KV_LAST_ERROR);
      return result;
    } catch (error) {
      this.store.setKv(KV_LAST_ERROR, errorMessage(error));
      throw error;
    } finally {
      await client.disconnect().catch(() => undefined);
    }
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
    const text = (message.message ?? "").trim();
    if (!text || isOwnReply(text)) return;

    if (settings.adminUserId && String(message.senderId ?? "") && String(message.senderId) !== settings.adminUserId) {
      return;
    }

    const ctx: TriggerContext = {
      defaultTarget: settings.defaultTarget || undefined,
      forwarded: await this.inferTarget(client, entity, message),
    };

    const parsed = parseTrigger(text, ctx);
    const reply = async (body: string) => {
      await client.sendMessage(entity as never, { message: body, parseMode: false });
    };

    if (!parsed.ok) {
      await reply(`⚠️ ${parsed.error}`);
      return;
    }

    const result = parsed.result;
    logs.push(`${result.kind}: ${text.slice(0, 60)}`);

    switch (result.kind) {
      case "help": {
        await reply(HELP_TEXT);
        return;
      }
      case "list": {
        await reply(this.renderTaskList());
        return;
      }
      case "create": {
        const task = this.createTask(result.task as TaskInput);
        await reply(
          `✅ 已创建任务 #${task.id}\n${task.name}\n⏰ ${formatInTimezone(task.nextRunAt, settings.timezone)}（${settings.timezone >= 0 ? "+" : ""}${settings.timezone}）\n${result.explanation ?? ""}`.trim(),
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
        const [log] = await this.runTasks([task], client);
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
      username?: string;
    };
    const kind = anyEntity.className === "Channel" ? "channel" : anyEntity.className === "Chat" ? "chat" : "user";
    let id = String(anyEntity.id ?? fallback);
    try {
      id = (await client.getPeerId(entity as never)) ?? id;
    } catch {
      /* ignore */
    }
    // 有 username 时不必再塞一个同名的 title，界面上会重复显示成 "@bot @bot"
    const title = anyEntity.title || anyEntity.firstName || undefined;
    return {
      kind,
      id,
      title,
      username: anyEntity.username,
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

  private createTask(input: TaskInput): Task {
    const settings = this.store.getSettings();
    const now = Date.now();
    const normalized = normalizeTaskInput(input);
    const nextRunAt = normalized.enabled ? computeNextRun(normalized.schedule, now, settings.timezone) : null;
    return this.store.createTask(normalized, now, nextRunAt);
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

  private async runTasks(tasks: Task[], client?: TelegramClient): Promise<LogEntry[]> {
    const runner = async (tg: TelegramClient): Promise<LogEntry[]> => {
      const results: LogEntry[] = [];
      for (const task of tasks) {
        results.push(await this.runSingleTask(tg, task));
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
    return this.runTasks(tasks);
  }

  private async runSingleTask(client: TelegramClient, task: Task): Promise<LogEntry> {
    const settings = this.store.getSettings();
    const sentKey = `task:${task.id}:sent`;
    const previousSent = this.store.getJson<number[]>(sentKey, []);
    const hooks: ExecHooks = { log: () => undefined };

    let log: LogEntry;
    try {
      const outcome = await executeTask(client, task, { previousSent, hooks });
      this.store.setJson(sentKey, outcome.sent);
      if (task.deleteAfterSeconds > 0 && outcome.sent.length) {
        this.store.addDeletion(outcome.chatId ?? task.target.id, outcome.sent, Date.now() + task.deleteAfterSeconds * 1000);
      }
      this.store.recordRun(task.id, outcome.ok ? "ok" : "fail", outcome.message, Date.now());
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
      this.store.recordRun(task.id, "fail", message, Date.now());
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

    // 计算下一次执行
    const fresh = this.store.getTask(task.id);
    if (fresh) {
      if (fresh.schedule.kind === "once") {
        this.store.updateTask(fresh.id, { enabled: false, nextRunAt: null }, Date.now());
      } else if (fresh.enabled) {
        this.store.setTaskNextRun(fresh.id, computeNextRun(fresh.schedule, Date.now(), settings.timezone));
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
        connected: false,
        pendingLogin: pending ? { phone: pending.phone, stage: pending.stage } : null,
        dc: Number(this.store.getKv("account:dc") ?? 0) || null,
        lastError: this.store.getKv(KV_LAST_ERROR),
      },
      settings,
      tasks,
      logs: this.store.listLogs(50),
      stats: {
        totalTasks: tasks.length,
        enabledTasks: tasks.filter((task) => task.enabled).length,
        nextRunAt: this.store.earliestNextRun(),
        lastRunAt,
      },
      now: Date.now(),
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
  return clean;
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
    .map((step) => {
      if (step.type === "wait") return { type: "wait" as const, seconds: Math.max(0, Number(step.seconds ?? 3)) };
      if (step.type === "random") return { type: "random" as const, options: (step.options ?? []).filter(Boolean) };
      if (step.type === "click") return { ...step, text: step.text ?? "", row: step.row, column: step.column };
      if (step.type === "number") return { type: "number" as const, value: String(step.value ?? "") };
      return { type: "text" as const, text: String(step.text ?? "") };
    })
    .filter((step) => {
      if (step.type === "text") return !!step.text;
      if (step.type === "random") return (step.options ?? []).length > 0;
      if (step.type === "number") return !!step.value;
      return true;
    });

  return {
    name: String(input.name ?? "").trim() || "未命名任务",
    enabled: input.enabled !== false,
    target: input.target,
    threadId: input.threadId ?? null,
    schedule,
    steps,
    successKeywords: (input.successKeywords ?? []).map((keyword) => String(keyword).trim()).filter(Boolean),
    timeoutSeconds: Math.max(5, Math.min(90, Number(input.timeoutSeconds ?? 25))),
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
修饰：#kw:签到成功|已签到  #jitter:120  #once  #delete:30  #timeout:40  #thread:12  #name:名称
目标：消息里写 @机器人，或把机器人消息转发/分享到收藏夹，或在设置里填默认目标

示例：
9.30 签到
9.30 签到 btn:立即签到 #kw:签到成功
8.30-9.30 参与 rand:早上好|午安
每2小时 打卡

管理命令：列表 / 立即 <编号> / 开启 <编号> / 关闭 <编号> / 删除 <编号> / 帮助`;
