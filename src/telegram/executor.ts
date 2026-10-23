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

/** 在自己的对话列表里按 username 找实体（resolveUsername 失败时的兜底） */
export async function findEntityByUsername(client: TelegramClient, username: string): Promise<EntityLike | null> {
  const wanted = username.toLowerCase().replace(/^@/, "");
  try {
    const dialogs = (await client.getDialogs({ limit: 200 })) as Array<{ entity?: { username?: string } }>;
    for (const dialog of dialogs) {
      const entity = dialog?.entity;
      const handle = typeof entity?.username === "string" ? entity.username.toLowerCase() : "";
      if (handle && handle === wanted) return entity as EntityLike;
    }
  } catch {
    /* 忽略 */
  }
  return null;
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

  // 最后兜底：contacts.resolveUsername 失败时，直接在对话列表里按 username 找
  const username = typeof target === "string" ? target.replace(/^@/, "") : target.username;
  if (username && /^[A-Za-z0-9_]{3,}$/.test(username)) {
    const found = await findEntityByUsername(client, username);
    if (found) return found;
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
  kind: "callback" | "url" | "webview" | "switch" | "text" | "other";
  data?: Buffer;
  url?: string;
  /** switch_inline 按钮要带的 query */
  query?: string;
  /** TL 里的类名，排查时有用 */
  className?: string;
  /** layer 232: KeyboardInlineButton 里的 type 类名（InlineButtonTypeCallback 等） */
  typeClassName?: string;
}

/** 去掉空格、emoji、标点后的文本，用于按钮匹配（机器人常在按钮前加图标） */
export function normalizeButtonText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

type ButtonLike = {
  className?: string;
  text?: string;
  data?: Buffer | Uint8Array;
  url?: string;
  type?: {
    className?: string;
    data?: Buffer | Uint8Array;
    url?: string;
    query?: string;
  };
};

/**
 * 解析一条消息上的按钮。
 *
 * 注意 layer 232 的 inline 按钮结构换成了
 *   KeyboardInlineButton { text, type: InlineButtonTypeCallback { data } | InlineButtonTypeUrl { url } | … }
 * 老版本则是 KeyboardButtonCallback { text, data } / KeyboardButtonUrl { text, url }。
 * 两种都要认，否则会出现「按钮匹配上了但点不动」。
 */
export function flattenButtons(message: Api.Message): ButtonInfo[] {
  const markup = (message as { replyMarkup?: unknown }).replyMarkup;
  if (!markup || typeof markup !== "object") return [];
  const rows = (markup as { rows?: Array<{ buttons?: unknown[] }> }).rows;
  if (!Array.isArray(rows)) return [];

  const result: ButtonInfo[] = [];
  rows.forEach((row, rowIndex) => {
    const buttons = Array.isArray(row.buttons) ? row.buttons : [];
    buttons.forEach((raw, columnIndex) => {
      const button = raw as ButtonLike;
      const className = button.className ?? "KeyboardButton";
      const type = button.type as Record<string, unknown> | undefined;
      const typeClassName = typeof type?.className === "string" ? type.className : undefined;
      const text = String(button.text ?? "");

      // 不依赖类名判断：谁的字段有值就是哪种按钮（layer 232 换过结构，
      // 老结构把 data/url 直接放按钮上，新结构放在 type 里）
      const data = (button.data ?? type?.data) as Buffer | Uint8Array | undefined;
      const url = (button.url ?? type?.url) as string | undefined;
      const query = type?.query as string | undefined;

      let kind: ButtonInfo["kind"] = "other";
      if (data !== undefined && data !== null) {
        kind = "callback";
      } else if (url) {
        kind = /WebView/i.test(`${typeClassName ?? ""}${className}`) ? "webview" : "url";
      } else if (query !== undefined) {
        kind = "switch";
      } else if (
        !type ||
        typeClassName === "ButtonTypeDefault" ||
        // 老结构的普通键盘按钮没有任何 type 字段
        className === "KeyboardButton"
      ) {
        // 普通键盘按钮（reply keyboard）："点击" = 把按钮文本当成消息发出去
        kind = "text";
      }

      result.push({
        row: rowIndex,
        column: columnIndex,
        text,
        kind,
        data: data ? Buffer.from(data as Uint8Array) : undefined,
        url,
        query,
        className,
        typeClassName,
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
    // 1) 原样精确
    const exact = buttons.find((button) => button.text.trim() === wanted);
    if (exact) return exact;
    // 2) 去掉空格/图标/标点后比较（机器人按钮常带 👤✅ 这类前缀）
    const normalized = normalizeButtonText(wanted);
    if (normalized) {
      const normalizedMatch = buttons.find((button) => normalizeButtonText(button.text).includes(normalized));
      if (normalizedMatch) return normalizedMatch;
    }
    // 3) 大小写不敏感包含
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
  return buttons
    .map((button) => {
      const meta = [button.kind, button.typeClassName ?? button.className].filter(Boolean).join(",");
      return `[${button.row},${button.column}] ${button.text || "(无文本)"} (${meta})`;
    })
    .join(" / ");
}

/** 把原始 replyMarkup 压成一行短文本，用于日志排查 */
export function describeRawMarkup(message: Api.Message, limit = 700): string {
  try {
    const markup = (message as { replyMarkup?: unknown }).replyMarkup;
    if (!markup) return "无 replyMarkup";
    const json = JSON.stringify(markup, (_key, value) => {
      if (value && typeof value === "object" && "className" in value) {
        const obj = value as { className?: string; data?: unknown; url?: unknown; text?: unknown; type?: unknown };
        return {
          className: obj.className,
          text: obj.text,
          url: obj.url,
          hasData: obj.data !== undefined,
          dataLength: obj.data && typeof obj === "object" && "length" in (obj.data as object) ? (obj.data as { length?: number }).length : undefined,
          type: obj.type,
        };
      }
      return value;
    });
    return json.length > limit ? `${json.slice(0, limit)}…` : json;
  } catch (error) {
    return `原始 markup 序列化失败：${errorMessage(error)}`;
  }
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

/**
 * 兜底：用 teleproto 自带的 `message.buttons` + `MessageButton.click()`。
 * HumanTG 适配器就是走这条路（它对按钮类型、switch_inline、password 的处理更全）。
 * 我们的手写实现覆盖不到的类型（或 layer 差异）就交给它。
 */
async function clickWithTeleprotoHelper(
  message: Api.Message,
  button: ButtonInfo,
): Promise<string | null> {
  const grid = (message as unknown as { buttons?: Array<Array<{ text?: string; click?: () => Promise<unknown> }>> }).buttons;
  if (!Array.isArray(grid) || !grid.length) return null;

  const flat = grid.flat().filter(Boolean);
  const wanted = normalizeButtonText(button.text);
  const match =
    flat.find((item) => normalizeButtonText(String(item?.text ?? "")) === wanted) ??
    (wanted ? flat.find((item) => normalizeButtonText(String(item?.text ?? "")).includes(wanted)) : undefined) ??
    flat.find((_, index) => index === button.row === undefined);
  const target = match ?? grid[button.row]?.[button.column];
  if (!target || typeof target.click !== "function") return null;

  try {
    const result = (await target.click()) as { message?: string } | undefined;
    return result && typeof result === "object" && result.message ? `机器人回应：${String(result.message).slice(0, 200)}` : "";
  } catch (error) {
    return `teleproto 点击失败：${errorMessage(error)}`;
  }
}

async function clickButton(
  client: TelegramClient,
  entity: EntityLike,
  message: Api.Message,
  button: ButtonInfo,
): Promise<string> {
  if (button.kind === "callback") {
    try {
      const peer = await client.getInputEntity(entity as never);
      const answer = (await client.invoke(
        new Api.messages.GetBotCallbackAnswer({
          peer: peer as Api.TypeEntityLike,
          msgId: message.id,
          data: button.data,
        }),
      )) as { message?: string };
      return answer?.message ? `机器人回应：${String(answer.message).slice(0, 200)}` : "";
    } catch (error) {
      const fallback = await clickWithTeleprotoHelper(message, button);
      if (fallback !== null) return `直接调用失败（${errorMessage(error)}），改用 teleproto 助手：${fallback || "已点击"}`;
      throw error;
    }
  }
  if (button.kind === "text") {
    // reply keyboard：点它的等价操作就是把按钮文本（含 emoji 前缀）发出去
    await client.sendMessage(entity as never, { message: button.text, parseMode: false });
    return `已按键盘按钮发送「${button.text}」`;
  }
  if (button.kind === "url") return `「${button.text}」是链接按钮，跳过：${button.url ?? ""}`;
  if (button.kind === "webview") return `「${button.text}」是 webview 按钮，跳过`;
  if (button.kind === "switch") return `「${button.text}」是 switch_inline 按钮，跳过`;
  const fallback = await clickWithTeleprotoHelper(message, button);
  if (fallback !== null) return `类型未识别，改用 teleproto 助手：${fallback || "已点击"}`;

  // 最后兜底：当成普通键盘按钮，把文本发出去（多数机器人靠文本匹配）
  if (button.text) {
    await client.sendMessage(entity as never, { message: button.text, parseMode: false });
    return `类型未识别（${button.typeClassName ?? button.className}），已按键盘按钮发送「${button.text}」`;
  }
  return `「${button.text}」类型不支持点击`;
}

function pickRandom(options: string[]): string {
  return options[Math.floor(Math.random() * options.length)] ?? "";
}

export interface ExecuteOptions {
  /** 上一次运行发出的消息 id，用于按需清理 */
  previousSent?: number[];
  /** 已经解析好的目标实体（agent 侧解析一次后传进来，避免重复 getEntity/getDialogs） */
  entity?: EntityLike;
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

  const entity = options.entity ?? (await resolveEntity(client, task.target));
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
          note(
            "info",
            `步骤${stepNo} 消息 #${candidate.message.id} 上有 ${candidate.buttons.length} 个按钮：${describeButtons(candidate.buttons)}`,
          );
          let button = selectButton(candidate.buttons, step);
          let buttonMessage = candidate.message;

          // reply keyboard 的菜单常常"沿用旧消息"（机器人只发一条新文本，键盘不变），
          // 所以锚定消息里找不到时，再往更早的历史里捞一次。
          if (!button && step.text) {
            const history = await fetchRecent(client, entity, 15).catch(() => [] as Api.Message[]);
            for (const older of history.slice().reverse()) {
              if (older.id === candidate.message.id) continue;
              const buttons = flattenButtons(older);
              const found = selectButton(buttons, step);
              if (found) {
                button = found;
                buttonMessage = older;
                interactive = { message: older, buttons };
                note("info", `步骤${stepNo} 按钮「${found.text}」来自更早的消息 #${older.id}`);
                break;
              }
            }
          }

          if (!button) {
            note("warn", `步骤${stepNo} 没找到按钮「${step.text ?? `${step.row},${step.column}`}」`);
            note("warn", `原始 markup：${describeRawMarkup(candidate.message)}`);
            break;
          }
          const clickNote = await clickButton(client, entity, buttonMessage, button);
          note("info", `步骤${stepNo} 点击「${button.text}」（${button.kind}）`);
          if (clickNote) note("info", `步骤${stepNo} ${clickNote}`);
          cursorId = Math.max(cursorId, buttonMessage.id, candidate.message.id);

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
