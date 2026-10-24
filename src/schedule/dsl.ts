/**
 * 触发消息解析器 —— 在收藏夹（或配置的控制会话）里发一条消息就能建任务。
 *
 * 语法：`[时间] [动作...] [修饰符...]`
 *   时间：9.30 / 09:30 / 21：05 / 0930；窗口 9.30-10.30；间隔 每30分 每2小时 2h
 *   动作：普通文本（带空格用引号）/ btn:按钮文本 / btn:0,1 / num:1 / wait:5 / rand:a|b|c / say:文本
 *   修饰：#kw:成功|已签到、#jitter:120、#once、#delete:30、#timeout:40、#delay:3、#thread:12、#name:xxx、#clean
 *   目标：@username 或 到:-1001234567890（否则取转发来源 / 设置里的 defaultTarget）
 *   命令：列表 / 立即 1 / 开启 1 / 关闭 1 / 删除 1 / 帮助
 */
import type { Schedule, Step, Target, TaskInput } from "../types";
import { formatTimeOfDay, parseTimeOfDay } from "./time";

export type CommandKind = "create" | "list" | "run" | "enable" | "disable" | "delete" | "help";

export interface ParsedTrigger {
  kind: CommandKind;
  argument?: string;
  task?: TaskInput;
  explanation?: string;
  /** 任务名是自动生成的（没写 #name:）—— 补全目标后应该用最终目标重新生成 */
  autoName?: boolean;
}

export interface TriggerContext {
  defaultTarget?: string;
  /** 触发消息的转发 / 分享来源（分享机器人到收藏夹时会带上） */
  forwarded?: Target | null;
  /** 触发消息所在会话（self = 收藏夹） */
  sourceChat?: Target | null;
  /** 管理界面的「试算」用：允许解析不到目标 */
  allowMissingTarget?: boolean;
}

export type ParseResult = { ok: true; result: ParsedTrigger } | { ok: false; error: string };

const TIME_PREFIX = /^(\d{1,2})[:.：](\d{1,2})-(\d{1,2})[:.：](\d{1,2})$/;
const INTERVAL_PREFIX = /^(?:每|every|interval)(\d+)(秒|s|sec|分钟|分|min|m|小时|h|钟头)$/i;
const SHORT_INTERVAL = /^(\d+)(m|h)$/i;
const ONCE_WORDS = new Set(["once", "一次", "仅一次", "只一次"]);
const DELETE_WORDS = new Set(["删除", "delete", "del", "移除"]);

/**
 * 触发前缀（可选）。设置后只有以它开头的消息才当配置解析，
 * 收藏夹里顺手记的笔记就不会被误解析。
 *
 * @example stripTriggerPrefix("tg 9.30 签到", "tg") → { matched: true, rest: "9.30 签到" }
 */
export function stripTriggerPrefix(
  text: string,
  prefix: string,
): { matched: boolean; rest: string } {
  const cleanedPrefix = prefix.trim();
  if (!cleanedPrefix) return { matched: true, rest: text };
  const trimmed = text.trimStart();
  if (!trimmed.toLowerCase().startsWith(cleanedPrefix.toLowerCase())) {
    return { matched: false, rest: text };
  }
  return { matched: true, rest: trimmed.slice(cleanedPrefix.length).trimStart() };
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;

  const flush = () => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] as string;

    // 反斜杠转义：`\"` → 字面量引号，`\\` → 字面量反斜杠（指令里要能表示引号）
    if (char === "\\") {
      const next = input[i + 1];
      if (next !== undefined) {
        current += next;
        i += 1;
        continue;
      }
      current += char;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'" || char === "“" || char === "「") {
      quote = char === "“" ? "”" : char === "「" ? "」" : char;
      continue;
    }
    if (char === "”" || char === "」") continue;
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return tokens;
}

export interface TimeToken {
  schedule: Schedule;
  label: string;
}

export function parseTimeToken(token: string): TimeToken | null {
  const window = TIME_PREFIX.exec(token);
  if (window) {
    const start = { hour: Number(window[1]), minute: Number(window[2]) };
    const end = { hour: Number(window[3]), minute: Number(window[4]) };
    if (start.hour < 24 && start.minute < 60 && end.hour < 24 && end.minute < 60) {
      const time = formatTimeOfDay(start.hour, start.minute);
      const windowEnd = formatTimeOfDay(end.hour, end.minute);
      return { schedule: { kind: "window", time, windowEnd }, label: `${time}–${windowEnd} 随机` };
    }
    return null;
  }

  const interval = INTERVAL_PREFIX.exec(token) ?? SHORT_INTERVAL.exec(token);
  if (interval) {
    const amount = Number(interval[1]);
    const unit = (interval[2] ?? "m").toLowerCase();
    const minutes = /h|小时|钟头/.test(unit) ? amount * 60 : /秒|sec|^s$/.test(unit) ? Math.max(1, Math.round(amount / 60)) : amount;
    if (minutes < 1) return null;
    return { schedule: { kind: "interval", intervalMinutes: minutes }, label: `每 ${minutes} 分钟` };
  }

  const time = parseTimeOfDay(token);
  if (time) {
    const label = formatTimeOfDay(time.hour, time.minute);
    return { schedule: { kind: "daily", time: label }, label: `每天 ${label}` };
  }
  return null;
}

/**
 * 在 token 序列里找时间表达式（不要求出现在第一个位置）。
 * 用户可以写 `https://t.me/xxx 9 /start ...` 或 `@bot 9.30 签到`。
 */
export function findTimeToken(tokens: string[]): { index: number; time: TimeToken } | null {
  for (let index = 0; index < tokens.length; index++) {
    const time = parseTimeToken(tokens[index]);
    if (time) return { index, time };
  }
  return null;
}

/** rand: 的选项只用 `|` 分隔（选项本身可能含逗号，比如「早上好，今天也要开心」） */
function splitOptions(value: string): string[] {
  return value
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitList(value: string): string[] {
  return value
    .split(/[|,，、]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 从 `https://t.me/xxx` / `t.me/xxx` / `telegram.me/xxx` 里取 username */
export function usernameFromLink(value: string): string | null {
  const match = /^(?:https?:\/\/)?(?:t|telegram)\.me\/([A-Za-z0-9_]{3,})(?:\?.*)?$/i.exec(value.trim());
  return match ? match[1] : null;
}

/**
 * 目标里的 `#12` 后缀表示话题 id：`@group#12`、`-1001234#12`。
 * 返回目标本体 + 话题 id（没写就是 undefined）。
 */
function splitThread(value: string): { value: string; threadId?: number } {
  const match = /^(.*?)#(\d{1,12})$/.exec(value.trim());
  if (!match) return { value: value.trim() };
  const threadId = Number(match[2]);
  return { value: match[1].trim(), threadId: Number.isFinite(threadId) && threadId > 0 ? threadId : undefined };
}

function targetFromId(value: string, source?: Target | null): Target {
  const base = value.trim().replace(/^到[:：]/, "").replace(/^(to|at)[:：]/, "");
  const { value: cleaned, threadId } = splitThread(base);
  const linkUsername = usernameFromLink(cleaned);
  if (linkUsername) {
    return { kind: "user", id: linkUsername, username: linkUsername, ...(threadId ? { threadId } : {}) };
  }
  if (cleaned.startsWith("@")) {
    return { kind: "user", id: cleaned.slice(1), username: cleaned.slice(1), ...(threadId ? { threadId } : {}) };
  }
  const kind: Target["kind"] = cleaned.startsWith("-100") ? "channel" : cleaned.startsWith("-") ? "chat" : "user";
  return { kind, id: cleaned, ...(threadId ? { threadId } : {}) };
}

function describeSteps(steps: Step[]): string {
  const parts: string[] = [];
  for (const step of steps) {
    switch (step.type) {
      case "text":
        parts.push(`发送「${step.text}」`);
        break;
      case "random":
        parts.push(`随机发送「${(step.options ?? []).join(" / ")}」`);
        break;
      case "click":
        parts.push(
          step.text !== undefined && step.text !== ""
            ? `点击「${step.text}」`
            : `点击按钮[${step.row ?? 0},${step.column ?? 0}]`,
        );
        break;
      case "number":
        parts.push(`发送数字 ${step.value}`);
        break;
      case "wait":
        parts.push(`等待 ${step.seconds ?? 3}s`);
        break;
    }
  }
  return parts.join(" → ");
}

const COMMANDS: Array<{ kind: CommandKind; words: string[] }> = [
  { kind: "list", words: ["列表", "list", "任务列表", "签到列表"] },
  { kind: "help", words: ["帮助", "help", "?", "？", "说明"] },
  { kind: "run", words: ["立即", "执行", "run"] },
  { kind: "enable", words: ["开启", "启用", "enable", "on"] },
  { kind: "disable", words: ["关闭", "禁用", "disable", "off"] },
  { kind: "delete", words: ["删除", "delete", "del"] },
];

function matchCommand(tokens: string[]): ParsedTrigger | null {
  if (!tokens.length) return null;
  const head = tokens[0].toLowerCase();
  const found = COMMANDS.find((command) => command.words.includes(head));
  if (!found) return null;
  const argument = tokens.slice(1).join(" ").trim();
  if (found.kind !== "list" && found.kind !== "help" && !argument) {
    return { kind: found.kind, argument: "" };
  }
  return { kind: found.kind, argument };
}

/**
 * 解析一条触发消息。
 * 返回的 TaskInput 还不含 id / nextRunAt，由 Agent 落库时补齐。
 */
export function parseTrigger(raw: string, ctx: TriggerContext = {}): ParseResult {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return { ok: false, error: "空消息" };

  const tokens = tokenize(text);
  if (!tokens.length) return { ok: false, error: "空消息" };

  const command = matchCommand(tokens);
  if (command) return { ok: true, result: command };

  // 时间表达式可以出现在任意位置（链接/目标写在前面也认）
  const timeMatch = findTimeToken(tokens);
  const schedule: Schedule | null = timeMatch ? timeMatch.time.schedule : null;
  const scheduleLabel = timeMatch ? timeMatch.time.label : "";
  const timeIndex = timeMatch ? timeMatch.index : -1;
  let index = 0;

  const steps: Step[] = [];
  const successKeywords: string[] = [];
  let target: Target | null = null;
  const extraTargets: Target[] = [];

  /** `到:a|b` / `@a|b` → 多个目标 */
  const parseTargetList = (value: string): Target[] =>
    value
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => targetFromId(item));
  let threadId: number | null = null;
  let jitterSeconds = 0;
  let timeoutSeconds = 30;
  let stepDelaySeconds = 3;
  let deleteAfterSeconds = 0;
  let cleanupPrevious = true;
  let onlyOnce = false;
  let useHere = false;
  let nameOverride = "";
  let pendingText = "";

  const pushText = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    pendingText = pendingText ? `${pendingText} ${trimmed}` : trimmed;
  };
  const flushText = () => {
    if (pendingText) {
      steps.push({ type: "text", text: pendingText });
      pendingText = "";
    }
  };

  for (; index < tokens.length; index++) {
    if (index === timeIndex) continue;
    const token = tokens[index];
    const lower = token.toLowerCase();
    const [rawKey, ...rest] = token.split(/[:：]/);
    // `#kw:` 和 `kw:` 等价
    const key = rawKey.replace(/^#/, "").toLowerCase();
    const value = rest.join(":").trim();
    const hasKey = rest.length > 0;

    if (ONCE_WORDS.has(lower.replace(/^#/, ""))) {
      onlyOnce = true;
      continue;
    }

    if (token.startsWith("#") && !hasKey) {
      const flag = lower.slice(1);
      if (flag === "clean") cleanupPrevious = true;
      if (flag === "keep") cleanupPrevious = false;
      if (ONCE_WORDS.has(flag)) onlyOnce = true;
      continue;
    }

    // @here / #here：发到当前这个会话（在群里发配置时最方便）
    if (/^(?:@|#)?(?:here|这里|当前|本群|当前群)$/i.test(token)) {
      useHere = true;
      continue;
    }

    // 裸链接 / @handle 先当目标处理。
    // 注意要放在 split(":") 之前：否则 "https://t.me/x" 会被当成键值对（key=https）
    if (/^(?:https?:\/\/|t\.me\/|telegram\.me\/|@)/i.test(token)) {
      const parsed = parseTargetList(token);
      target = parsed[0] ?? target;
      extraTargets.push(...parsed.slice(1));
      continue;
    }

    if (!hasKey) {
      // 裸的 t.me/xxx 链接直接当目标，而不是当成要发送的文本
      const linkUsername = usernameFromLink(token);
      if (linkUsername) {
        target = { kind: "user", id: linkUsername, username: linkUsername };
        continue;
      }
      pushText(token);
      continue;
    }

    switch (key) {
      case "btn":
      case "按钮": {
        flushText();
        const position = /^(\d+)\s*,\s*(\d+)$/.exec(value);
        if (position) {
          steps.push({ type: "click", row: Number(position[1]), column: Number(position[2]) });
        } else {
          steps.push({ type: "click", text: value });
        }
        break;
      }
      case "num":
      case "数字": {
        flushText();
        steps.push({ type: "number", value });
        break;
      }
      case "wait":
      case "等":
      case "sleep": {
        flushText();
        steps.push({ type: "wait", seconds: Math.max(0, Math.min(600, Number(value) || 3)) });
        break;
      }
      case "rand":
      case "随机": {
        flushText();
        const options = splitOptions(value);
        if (options.length) steps.push({ type: "random", options });
        break;
      }
      case "say":
      case "说":
      case "text":
      case "文本": {
        flushText();
        steps.push({ type: "text", text: value });
        break;
      }
      case "kw":
      case "关键词": {
        flushText();
        successKeywords.push(...splitList(value));
        break;
      }
      case "jitter":
      case "随机延迟": {
        flushText();
        jitterSeconds = Math.max(0, Math.min(3600, Number(value) || 0));
        break;
      }
      case "delete":
      case "删除": {
        flushText();
        deleteAfterSeconds = Math.max(0, Math.min(3600, Number(value) || 0));
        break;
      }
      case "delay":
      case "间隔": {
        flushText();
        stepDelaySeconds = Math.max(0, Math.min(60, Number(value) || 0));
        break;
      }
      case "timeout":
      case "超时": {
        flushText();
        timeoutSeconds = Math.max(5, Math.min(120, Number(value) || 30));
        break;
      }
      case "thread":
      case "话题": {
        flushText();
        threadId = Number(value) || null;
        break;
      }
      case "name":
      case "名称": {
        flushText();
        nameOverride = value;
        break;
      }
      case "to":
      case "at":
      case "到": {
        flushText();
        const parsed = parseTargetList(value);
        target = parsed[0] ?? target;
        extraTargets.push(...parsed.slice(1));
        break;
      }
      case "clean": {
        flushText();
        cleanupPrevious = true;
        break;
      }
      default:
        pushText(token);
        break;
    }
  }
  flushText();

  if (!schedule) {
    return { ok: false, error: "缺少时间：参考 `9.30 签到` 或 `每2小时 签到`" };
  }
  if (!steps.length) {
    return { ok: false, error: "缺少动作：时间后面要写要发送的内容，例如 `9.30 签到`" };
  }

  if (useHere && !ctx.sourceChat && !ctx.allowMissingTarget) {
    return { ok: false, error: "@here 只能在控制会话里用：它表示「发到当前这个会话」" };
  }

  const resolvedTarget: Target | null =
    target ??
    (useHere ? (ctx.sourceChat ?? null) : null) ??
    ctx.forwarded ??
    (ctx.defaultTarget ? targetFromId(ctx.defaultTarget) : null) ??
    (ctx.allowMissingTarget ? { kind: "user", id: "", title: "（待指定目标）" } : null);

  if (!resolvedTarget) {
    return {
      ok: false,
      error:
        "找不到签到目标：把机器人消息转发/分享到收藏夹、或直接回复那条消息，也可以在消息里写 @机器人，或在设置里填默认目标",
    };
  }

  if (onlyOnce) schedule.kind = "once";
  schedule.jitterSeconds = jitterSeconds;

  const label = nameOverride || defaultName(resolvedTarget, scheduleLabel, steps);

  const allTargets = [resolvedTarget, ...extraTargets].filter(
    (item, index, list) =>
      item &&
      list.findIndex(
        (other) => other && (other.username || other.id).toLowerCase() === (item.username || item.id).toLowerCase(),
      ) === index,
  );

  const task: TaskInput = {
    name: label,
    enabled: true,
    target: resolvedTarget,
    targets: allTargets.length > 1 ? allTargets : undefined,
    threadId,
    schedule,
    steps,
    successKeywords,
    timeoutSeconds,
    stepDelaySeconds,
    deleteAfterSeconds,
    cleanupPrevious,
    source: "trigger",
  };

  const targetLabel = resolvedTarget.title || (resolvedTarget.username ? `@${resolvedTarget.username}` : resolvedTarget.id);
  const keywords = successKeywords.length ? `，成功关键词：${successKeywords.join(" / ")}` : "";
  const explanation = `${scheduleLabel || "每天"} → ${targetLabel}：${describeSteps(steps)}${keywords}`;

  return { ok: true, result: { kind: "create", task, explanation, autoName: !nameOverride } };
}

/**
 * 目标从"只有 @username"补全成"有显示名"之后，把当初按旧标签自动生成的任务名同步一下。
 * 只处理「名字以旧标签开头」的情况 —— 用户自己起的名字不动。
 */
export function renameForTarget(name: string, oldTarget: Target, newTarget: Target): string {
  const oldLabel = oldTarget.username ? `@${oldTarget.username}` : oldTarget.id;
  const newLabel = newTarget.title || (newTarget.username ? `@${newTarget.username}` : newTarget.id);
  if (!oldLabel || !newLabel || oldLabel === newLabel) return name;
  if (!newTarget.title) return name; // 只为了拿显示名才改名
  if (!name.startsWith(oldLabel)) return name;
  return `${newLabel}${name.slice(oldLabel.length)}`;
}

export function defaultName(target: Target, scheduleLabel: string, steps: Step[]): string {
  // 优先用群名 / 机器人显示名，其次 @username，最后才是数字 id
  const targetLabel = target.title || (target.username ? `@${target.username}` : target.id);
  const firstText = steps.find((step) => step.type === "text")?.text;
  const firstRandom = steps.find((step) => step.type === "random")?.options?.[0];
  const action = firstText || (firstRandom ? `随机消息` : "按键");
  const name = [targetLabel, action].filter(Boolean).join(" ");
  return name.length > 40 ? name.slice(0, 40) : name;
}

export { describeSteps };
