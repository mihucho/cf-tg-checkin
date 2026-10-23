/**
 * 签到动作执行器：发消息 / 等回复 / 点按钮（多步骤）/ 判定成功 / 清理消息。
 *
 * 关键设计：不依赖 updates 推送（DO 会被驱逐，长连接不可靠），
 * 每一步都通过 messages.getHistory 轮询机器人回复，因此每次执行都是自包含的。
 */
import { Api } from "teleproto";
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

/** 支持 @username / 数字 id / 邀请链接 / me */
export function targetRef(target: Target | string): string {
  const raw = typeof target === "string" ? target : target.id || target.username || "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed === "self" || trimmed === "me") return "me";
  if (trimmed.startsWith("@")) return trimmed;
  if (/^-?\d+$/.test(trimmed)) return trimmed;
  if (/^https?:|^t\.me\//i.test(trimmed)) return trimmed;
  return `@${trimmed}`;
}

export async function resolveEntity(client: TelegramClient, target: Target | string): Promise<EntityLike> {
  const ref = targetRef(target);
  if (!ref) throw new Error("目标为空");
  return (await client.getEntity(ref)) as EntityLike;
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

/**
 * 轮询等待「带按钮的最新消息」，同时容忍机器人编辑同一条消息（而不是发新消息）的情况。
 */
async function waitForInteractive(
  client: TelegramClient,
  entity: EntityLike,
  afterId: number,
  deadline: number,
  hooks: ExecHooks,
): Promise<InteractiveMessage | null> {
  let lastSeenId = afterId;
  while (Date.now() < deadline) {
    let messages: Api.Message[] = [];
    try {
      messages = await fetchRecent(client, entity);
    } catch (error) {
      hooks.log("warn", `拉取消息失败：${errorMessage(error)}`);
    }
    const candidates = messages.filter((message) => message.id >= lastSeenId || message.id > afterId);
    for (const message of candidates.slice().reverse()) {
      const buttons = flattenButtons(message);
      if (buttons.length) return { message, buttons };
    }
    if (candidates.length) lastSeenId = Math.max(lastSeenId, ...candidates.map((message) => message.id));
    await sleep(1200);
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
  const deadline = Date.now() + timeoutMs;
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
            interactive ?? (await waitForInteractive(client, entity, cursorId, deadline, hooks));
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
          // 点击后机器人通常会新发一条消息或编辑当前消息，重新等待交互消息
          const next = await waitForInteractive(client, entity, cursorId, Math.min(deadline, Date.now() + 12_000), hooks);
          interactive = next ?? null;
          break;
        }
        default:
          note("warn", `未知步骤类型 ${(step as Step).type}`);
      }
    } catch (error) {
      note("error", `步骤${stepNo} 失败：${errorMessage(error)}`);
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
