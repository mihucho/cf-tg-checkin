/**
 * 签到动作执行器：发消息 / 等回复 / 点按钮（多步骤）/ 判定成功 / 清理消息。
 *
 * 关键设计：不依赖 updates 推送（DO 会被驱逐，长连接不可靠），
 * 每一步都通过 messages.getHistory 轮询机器人回复，因此每次执行都是自包含的。
 */
import { Api } from "teleproto";
import bigInt from "big-integer";
import { Buffer } from "node:buffer";
import type { TelegramClient } from "teleproto";
import type { Step, Target, Task } from "../types";
import { errorMessage } from "./client";

export type LogLevel = "info" | "warn" | "error";

export interface ExecHooks {
  log(level: LogLevel, message: string): void;
}

export interface ExecuteOutcome {
  ok: boolean;
  message: string;
  detail: string;
  sent: number[];
  /** 聊天 id（字符串），用于稍后删除 */
  chatId: string | null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export type EntityLike = Parameters<TelegramClient["getInputEntity"]>[0];

/**
 * 支持 @username / 数字 id / 邀请链接 / me。
 *
 * 注意：Target 里同时有 username 和数字 id 时**优先用 username** ——
 * 数字 id 解析需要 access_hash，换了新连接 / 新 session 时可能拿不到，
 * 会报 "Could not find the input entity for ..."。
 */
export function targetRef(target: Target | string): string {
  const raw =
    typeof target === "string" ? target : target.username || target.id || "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed === "self" || trimmed === "me") return "me";
  if (trimmed.startsWith("@")) return trimmed;
  if (/^-?\d+$/.test(trimmed)) return trimmed;
  if (/^https?:|^t\.me\//i.test(trimmed)) return trimmed;
  return `@${trimmed}`;
}

/**
 * 用 access_hash 直接构造 InputPeer。
 * 私有机器人 / 用户没有 username 时，只能靠它来解析（前提是建任务时抓到了 hash）。
 */
export function inputPeerFromTarget(target: Target | string): Api.TypeInputPeer | null {
  if (typeof target === "string" || !target.accessHash) return null;
  try {
    const hash = bigInt(target.accessHash);
    const rawId = String(target.id || "");
    if (target.kind === "channel") {
      const channelId = rawId.startsWith("-100") ? rawId.slice(4) : rawId.replace(/^-/, "");
      return new Api.InputPeerChannel({ channelId: bigInt(channelId), accessHash: hash });
    }
    if (target.kind === "chat") {
      return new Api.InputPeerChat({ chatId: bigInt(rawId.replace(/^-/, "")) });
    }
    return new Api.InputPeerUser({ userId: bigInt(rawId.replace(/^@/, "")), accessHash: hash });
  } catch {
    return null;
  }
}

/**
 * 解析目标实体。做法和 bncr 的 HumanTG 适配器一致（三层兜底）：
 *
 *   1. 直接 getEntity（命中 session 里的实体缓存最快）
 *   2. 失败且是 "Could not find the input entity" → `getDialogs()` 预热缓存后重试
 *      （teleproto 解析数字 id 需要 access_hash，而 access_hash 只有"见过"对方才有）
 *   3. 还是不行就报出可操作的错误
 *
 * 我们的 client 每次执行都是新建的，所以第 2 步是常态，不能省。
 */
export async function resolveEntity(client: TelegramClient, target: Target | string): Promise<EntityLike> {
  const ref = targetRef(target);
  const peer = inputPeerFromTarget(target);
  if (!ref && !peer) throw new Error("目标为空");

  const attempts: unknown[] = [];
  if (ref) attempts.push(ref);
  if (peer) attempts.push(peer);

  const tryAll = async (): Promise<{ entity?: EntityLike; error?: unknown }> => {
    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        return { entity: (await client.getEntity(attempt as never)) as EntityLike };
      } catch (error) {
        lastError = error;
      }
    }
    return { error: lastError };
  };

  const first = await tryAll();
  if (first.entity) return first.entity;

  const message = errorMessage(first.error).toUpperCase();
  const isEntityError = message.includes("INPUT ENTITY") || message.includes("COULD NOT FIND");

  if (isEntityError) {
    try {
      // getDialogs 会把最近对话的实体写进 session 缓存
      await client.getDialogs({ limit: 100 });
    } catch {
      /* 拉不到对话就继续走报错 */
    }
    const second = await tryAll();
    if (second.entity) return second.entity;
  }

  throw new Error(
    `无法解析目标「${ref || (peer ? "access_hash" : "")}」：${errorMessage(first.error)}；` +
      `私有机器人请先在 Telegram 里和它对话，或把任务目标改成 @username`,
  );
}

export interface ButtonInfo {
  row: number;
  column: number;
  text: string;
  kind: "callback" | "url" | "webview" | "text" | "other";
  data?: Buffer;
}

export function flattenButtons(message: Api.Message): ButtonInfo[] {
  const markup = (message as { replyMarkup?: unknown }).replyMarkup;
  if (!markup || typeof markup !== "object") return [];
  const rows = (markup as { rows?: Array<{ buttons?: unknown[] }> }).rows;
  if (!Array.isArray(rows)) return [];

  const result: ButtonInfo[] = [];
  rows.forEach((row, rowIndex) => {
    const buttons = Array.isArray(row.buttons) ? row.buttons : [];
    buttons.forEach((raw, columnIndex) => {
      const button = raw as {
        className?: string;
        text?: string;
        data?: Buffer | Uint8Array;
        url?: string;
      };
      const className = button.className ?? "";
      const text = String(button.text ?? "");
      let kind: ButtonInfo["kind"] = "other";
      if (button.data) kind = "callback";
      else if (button.url) kind = "url";
      else if (/WebView/i.test(className)) kind = "webview";
      else if (className === "KeyboardButton" || className === "" || !/Inline|Callback|Url/.test(className)) kind = "text";
      result.push({
        row: rowIndex,
        column: columnIndex,
        text,
        kind,
        data: button.data ? Buffer.from(button.data as Uint8Array) : undefined,
      });
    });
  });
  return result;
}

export function hasButtons(message: Api.Message): boolean {
  return flattenButtons(message).length > 0;
}

export function selectButton(buttons: ButtonInfo[], step: Step): ButtonInfo | null {
  const wanted = (step.text ?? "").trim();
  if (wanted) {
    const exact = buttons.find((button) => button.text.trim() === wanted);
    if (exact) return exact;
    const contains = buttons.find((button) => button.text.includes(wanted));
    if (contains) return contains;
    const lower = wanted.toLowerCase();
    const insensitive = buttons.find((button) => button.text.toLowerCase().includes(lower));
    if (insensitive) return insensitive;
    return null;
  }
  const row = step.row ?? 0;
  const column = step.column ?? 0;
  return buttons.find((button) => button.row === row && button.column === column) ?? null;
}

export function describeButtons(buttons: ButtonInfo[]): string {
  return buttons.map((button) => `[${button.row},${button.column}] ${button.text}`).join(" / ");
}

/** 同一套按钮的"指纹"：用来判断点完之后菜单到底变没变（机器人常原地编辑同一条消息） */
export function buttonSignature(buttons: ButtonInfo[]): string {
  return buttons.map((button) => `${button.row},${button.column}:${button.kind}:${button.text}`).join("|");
}

async function fetchRecent(client: TelegramClient, entity: EntityLike, limit = 12): Promise<Api.Message[]> {
  const messages = (await client.getMessages(entity as never, { limit })) as Api.Message[];
  return messages.slice().sort((a, b) => a.id - b.id);
}

async function latestMessageId(client: TelegramClient, entity: EntityLike): Promise<number> {
  try {
    const messages = await fetchRecent(client, entity, 1);
    return messages.length ? messages[messages.length - 1].id : 0;
  } catch {
    return 0;
  }
}

interface InteractiveMessage {
  message: Api.Message;
  buttons: ButtonInfo[];
}

interface InteractiveSkip {
  msgId: number;
  signature: string;
}

/**
 * 轮询等待「带按钮的消息」，同时容忍机器人编辑同一条消息（而不是发新消息）的情况。
 *
 * @param skip 刚点过的那一套按钮：机器人若原地编辑同一条消息，按钮指纹变了才算"新菜单"，
 *             否则会把同一个按钮再点一次。
 */
async function waitForInteractive(
  client: TelegramClient,
  entity: EntityLike,
  afterId: number,
  deadline: number,
  hooks: ExecHooks,
  options: { pollIntervalMs: number; skip?: InteractiveSkip },
): Promise<InteractiveMessage | null> {
  while (Date.now() < deadline) {
    let messages: Api.Message[] = [];
    try {
      messages = await fetchRecent(client, entity);
    } catch (error) {
      hooks.log("warn", `拉取消息失败：${errorMessage(error)}`);
    }
    const candidates = messages.filter((message) => message.id >= afterId);
    for (const message of candidates.slice().reverse()) {
      const buttons = flattenButtons(message);
      if (!buttons.length) continue;
      const skip = options.skip;
      if (skip && message.id === skip.msgId && buttonSignature(buttons) === skip.signature) continue;
      return { message, buttons };
    }
    await sleep(options.pollIntervalMs);
  }
  return null;
}

async function clickButton(
  client: TelegramClient,
  entity: EntityLike,
  message: Api.Message,
  button: ButtonInfo,
): Promise<void> {
  if (button.kind === "callback") {
    const peer = await client.getInputEntity(entity as never);
    await client.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer: peer as Api.TypeEntityLike,
        msgId: message.id,
        data: button.data,
      }),
    );
    return;
  }
  if (button.kind === "text") {
    await client.sendMessage(entity as never, { message: button.text, parseMode: false });
    return;
  }
  if (button.kind === "url") throw new Error(`按钮「${button.text}」是链接按钮，无法点击`);
  if (button.kind === "webview") throw new Error(`按钮「${button.text}」是 webview 按钮，无法点击`);
  throw new Error(`按钮「${button.text}」类型不支持点击`);
}

function pickRandom(options: string[]): string {
  return options[Math.floor(Math.random() * options.length)] ?? "";
}

export interface ExecuteOptions {
  /** 上一次运行发出的消息 id，用于按需清理 */
  previousSent?: number[];
  hooks: ExecHooks;
  /** 等待下一步按钮时，每次检测的间隔（毫秒，默认 3000） */
  pollIntervalMs?: number;
  /** 单次最多等待多久（毫秒，默认 30000） */
  stepWaitMs?: number;
}

export async function executeTask(
  client: TelegramClient,
  task: Task,
  options: ExecuteOptions,
): Promise<ExecuteOutcome> {
  const { hooks } = options;
  const detail: string[] = [];
  const note = (level: LogLevel, message: string) => {
    detail.push(`${level === "error" ? "✗" : level === "warn" ? "!" : "·"} ${message}`);
    hooks.log(level, message);
  };

  const entity = await resolveEntity(client, task.target);
  const chatId = String((entity as { id?: unknown }).id ?? task.target.id);
  const timeoutMs = Math.max(5, Math.min(90, task.timeoutSeconds || 25)) * 1000;
  /** 每等待一次机器人回复的超时时间（从每次等待开始算，不被步骤间隔吃掉） */
  const interactiveDeadline = () => Date.now() + timeoutMs;
  /** 检测间隔 / 单次最长等待（设置里可调，默认 3s 一次、最多 30s） */
  const pollIntervalMs = Math.max(500, Math.min(30_000, options.pollIntervalMs ?? 3000));
  const stepWaitDeadline = () => Date.now() + Math.max(pollIntervalMs, Math.min(300_000, options.stepWaitMs ?? 30_000));
  const stepDelayMs = Math.max(0, Math.min(60, task.stepDelaySeconds ?? 3)) * 1000;
  const sent: number[] = [];

  if (task.cleanupPrevious && options.previousSent?.length) {
    try {
      await client.deleteMessages(entity as never, options.previousSent, { revoke: true });
      note("info", `清理上次发送的 ${options.previousSent.length} 条消息`);
    } catch (error) {
      note("warn", `清理上次消息失败：${errorMessage(error)}`);
    }
  }

  const baseline = await latestMessageId(client, entity);
  let interactive: InteractiveMessage | null = null;
  let cursorId = baseline;

  for (const [index, step] of task.steps.entries()) {
    const stepNo = index + 1;
    try {
      switch (step.type) {
        case "text":
        case "random":
        case "number": {
          const text =
            step.type === "text"
              ? (step.text ?? "")
              : step.type === "number"
                ? (step.value ?? "")
                : pickRandom(step.options ?? []);
          if (!text) {
            note("warn", `步骤${stepNo} 内容为空，跳过`);
            break;
          }
          const sentMessage = (await client.sendMessage(entity as never, {
            message: text,
            parseMode: false,
            replyTo: task.threadId ?? undefined,
          })) as Api.Message;
          if (sentMessage?.id) {
            sent.push(sentMessage.id);
            cursorId = Math.max(cursorId, sentMessage.id);
          }
          note("info", `步骤${stepNo} 发送「${text}」`);
          break;
        }
        case "wait": {
          const seconds = Math.max(0, Math.min(600, step.seconds ?? 3));
          note("info", `步骤${stepNo} 等待 ${seconds}s`);
          await sleep(seconds * 1000);
          break;
        }
        case "click": {
          const candidate: InteractiveMessage | null =
            interactive ??
            (await waitForInteractive(client, entity, cursorId, Math.min(interactiveDeadline(), stepWaitDeadline()), hooks, {
              pollIntervalMs,
            }));
          if (!candidate) {
            note("warn", `步骤${stepNo} 没有等到带按钮的消息`);
            break;
          }
          interactive = candidate;
          const button = selectButton(candidate.buttons, step);
          if (!button) {
            note("warn", `步骤${stepNo} 没找到按钮「${step.text ?? `${step.row},${step.column}`}」，可选：${describeButtons(candidate.buttons)}`);
            break;
          }
          await clickButton(client, entity, candidate.message, button);
          note("info", `步骤${stepNo} 点击「${button.text}」`);
          cursorId = Math.max(cursorId, candidate.message.id);

          // 点完之后机器人通常是「新发一条消息」或「原地编辑同一条消息」，
          // 两种都等，但要排除"还是原来那套按钮"（否则下一步会重复点同一个按钮）
          const next = await waitForInteractive(
            client,
            entity,
            cursorId,
            Math.min(interactiveDeadline(), stepWaitDeadline()),
            hooks,
            {
              pollIntervalMs,
              skip: { msgId: candidate.message.id, signature: buttonSignature(candidate.buttons) },
            },
          );
          if (!next) {
            note("warn", `步骤${stepNo} 点击后 ${Math.round((options.stepWaitMs ?? 30_000) / 1000)}s 内没有等到新的按钮菜单`);
          }
          interactive = next ?? null;
          break;
        }
        default:
          note("warn", `未知步骤类型 ${(step as Step).type}`);
      }
    } catch (error) {
      note("error", `步骤${stepNo} 失败：${errorMessage(error)}`);
    }

    // 步骤之间默认停一会儿，给机器人留出响应时间（wait 步骤本身就是等待，不叠加）
    const isLastStep = index === task.steps.length - 1;
    if (!isLastStep && step.type !== "wait" && stepDelayMs > 0) {
      note("info", `步骤间等待 ${Math.round(stepDelayMs / 1000)}s`);
      await sleep(stepDelayMs);
    }
  }

  // 判定成功
  let ok = true;
  let message = "执行完成";
  if (task.successKeywords?.length) {
    const messages = await fetchRecent(client, entity).catch(() => [] as Api.Message[]);
    const fresh = messages.filter((item) => item.id > baseline && !item.out);
    const texts = fresh.map((item) => item.message ?? "");
    const hit = task.successKeywords.find((keyword) => texts.some((text) => text.includes(keyword)));
    if (hit) {
      message = `命中关键词「${hit}」`;
      note("info", message);
    } else {
      ok = false;
      message = `未匹配到关键词（${task.successKeywords.join(" / ")}）`;
      const preview = texts.filter(Boolean).slice(-2).join(" | ");
      note("warn", preview ? `${message}；最近回复：${preview.slice(0, 300)}` : message);
    }
  }

  return { ok, message, detail: detail.join("\n"), sent, chatId };
}
