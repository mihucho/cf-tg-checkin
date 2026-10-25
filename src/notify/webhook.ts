/**
 * 失败提醒的 Webhook：按设置里手动选择的渠道，拼对应的包体。
 *
 * 为什么不能只发一份通用 JSON：
 *  - 钉钉 / 企业微信 / 飞书 自定义机器人都有私有包体格式，发扁平 JSON 会被直接丢弃；
 *  - 它们**出错也返回 HTTP 200**，错误在 body 的 errcode/code 里，
 *    所以必须解析响应，否则「消息没到」也会被记成成功；
 *  - 钉钉开启「加签」时还要把 timestamp + sign 拼到 URL 上（HMAC-SHA256）。
 *
 * 渠道由用户在设置里显式选择（不靠域名猜）；`detectWebhookKind()` 只用于老配置的迁移兜底。
 */

import type { WebhookKind } from "../types";
import type { DigestCard } from "./digest";

export type { WebhookKind };

export interface WebhookMessage {
  taskId?: number | null;
  taskName?: string | null;
  title: string;
  text: string;
  at: number;
  /** 日报/周报的卡片内容：钉钉、飞书、企业微信会渲染成 Markdown / 卡片 */
  card?: DigestCard;
}

export interface WebhookPayload {
  url: string;
  body: string;
  kind: WebhookKind;
}

export interface WebhookTemplate {
  /** 固定地址前缀（token 拼在后面） */
  base: string;
  /** token 放在 query 的哪个参数上（自定义渠道为 null） */
  queryKey: string | null;
  label: string;
  tokenLabel: string;
  tokenHint: string;
}

/**
 * 各渠道的固定地址：选了渠道就只剩「填 token」这一件事，不用自己拼 URL。
 * 自定义渠道（自建服务）没有模板，仍然填完整地址。
 */
export const WEBHOOK_TEMPLATES: Record<Exclude<WebhookKind, "generic">, WebhookTemplate> = {
  dingtalk: {
    base: "https://oapi.dingtalk.com/robot/send",
    queryKey: "access_token",
    label: "钉钉自定义机器人",
    tokenLabel: "机器人 Token（access_token）",
    tokenHint: "钉钉群 → 群设置 → 机器人 → 自定义机器人 → Webhook 地址里 &access_token= 后面那一段。",
  },
  wecom: {
    base: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send",
    queryKey: "key",
    label: "企业微信群机器人",
    tokenLabel: "机器人 Key",
    tokenHint: "企业微信群 → 群机器人 → 添加后 Webhook 地址里 key= 后面那一段。",
  },
  feishu: {
    base: "https://open.feishu.cn/open-apis/bot/v2/hook",
    queryKey: null,
    label: "飞书自定义机器人",
    tokenLabel: "机器人 Token",
    tokenHint: "飞书群 → 设置 → 群机器人 → 自定义机器人 → Webhook 地址最后那一段。",
  },
};

/** 用固定模板 + token 拼出地址（token 里如果是一整个 URL，会先把 token 抠出来） */
export function webhookUrlFromToken(kind: WebhookKind, rawToken: string): string {
  const value = String(rawToken ?? "").trim();
  if (!value) return "";
  const template = kind === "generic" ? null : WEBHOOK_TEMPLATES[kind];
  if (!template) return value; // 自定义渠道：原样当地址用

  // 用户直接粘了完整地址 / 自带参数时，先把 token 解析出来
  const token = webhookTokenFromUrl(kind, value) || value;
  // token 里混进了别的 query（很少见）：只取第一段
  const clean = token.split(/[&#?]/)[0] ?? "";
  if (!clean) return "";
  if (template.queryKey) {
    return `${template.base}?${template.queryKey}=${encodeURIComponent(clean)}`;
  }
  return `${template.base}/${encodeURIComponent(clean)}`;
}

/** 从已保存的地址里把 token 抠回来，好回填到输入框 */
export function webhookTokenFromUrl(kind: WebhookKind, rawUrl: string): string {
  const value = String(rawUrl ?? "").trim();
  if (!value) return "";
  const template = kind === "generic" ? null : WEBHOOK_TEMPLATES[kind];
  if (!template) return value;

  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (template.queryKey) return url.searchParams.get(template.queryKey) ?? "";
    const marker = "/hook/";
    const index = url.pathname.indexOf(marker);
    return index >= 0 ? url.pathname.slice(index + marker.length) : url.pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    return value;
  }
}

/**
 * 把人填的地址补成完整 URL。
 *
 * 实际最常见的错填是「只粘了 access_token」或者「少了 https://」——
 * 钉钉/企微/飞书的机器人配置页上，token 是单独一行，很容易只复制到那一串。
 * 这里按已选渠道把裸 token 拼回完整地址，省得用户自己去翻文档。
 */
export function normalizeWebhookUrl(rawValue: string, kind: WebhookKind): string {
  const value = String(rawValue ?? "").trim();
  if (!value) return "";
  // 已经是完整地址
  if (/^https?:\/\//i.test(value)) return value;
  // 少了协议头（oapi.dingtalk.com/robot/send?access_token=…）
  if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(value)) return `https://${value}`;
  // 看起来就是裸 token（16 位以上的字母数字）：按渠道模板拼
  if (/^[A-Za-z0-9_-]{16,}$/.test(value)) return webhookUrlFromToken(kind, value);
  return value;
}

/**
 * 打码后的地址，用于「测试通知」结果里回显——只露域名和 token 首尾，
 * 既能让人确认"到底推去了哪"，又不会把 token 打进日志/截图。
 */
export function maskWebhookUrl(rawUrl: string): string {
  const value = String(rawUrl ?? "").trim();
  if (!value) return "";
  // 不是地址（只填了 token 之类）就原样露出前几位，别再套一层 https:// 误导人
  if (!/^https?:\/\//i.test(value) && !/^[a-z0-9.-]+\.[a-z]{2,}(\/|$|\?)/i.test(value)) {
    return value.length > 6 ? `${value.slice(0, 6)}****` : "****";
  }
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const masked = url.search.replace(/([?&][^=]+=)([^&]*)/g, (_all, prefix: string, val: string) => {
      const shown = val.length <= 8 ? val : `${val.slice(0, 4)}****${val.slice(-4)}`;
      return `${prefix}${shown}`;
    });
    const path = url.pathname.replace(/\/([A-Za-z0-9_-]{12,})$/, "/****");
    return `${url.protocol}//${url.host}${path || "/"}${masked}`;
  } catch {
    // 压根不是地址（比如只填了 token）：原样露出前 12 个字符，方便看出填错了
    return value.length > 6 ? `${value.slice(0, 6)}****` : "****";
  }
}

/**
 * 老配置没有 `notifyWebhookKind` 时用来兜底猜一次（之后以设置里的手动选择为准）。
 */
export function detectWebhookKind(rawUrl: string): WebhookKind {
  let host = "";
  try {
    host = new URL(rawUrl.trim()).hostname.toLowerCase();
  } catch {
    return "generic";
  }
  if (host.endsWith("dingtalk.com") || host.endsWith("dingtalkapps.com")) return "dingtalk";
  if (host.endsWith("weixin.qq.com")) return "wecom";
  if (host.endsWith("feishu.cn") || host.endsWith("larksuite.com")) return "feishu";
  return "generic";
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 钉钉加签：`base64(HMAC-SHA256(key=secret, `${timestamp}\n${secret}`))`。
 * 返回**未编码**的 base64 —— URL 编码交给 URLSearchParams 做一次，
 * 提前编码会被二次转义（`+` → `%2B` → `%252B`），钉钉校验就失败。
 */
export async function dingtalkSign(secret: string, timestamp: number): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}\n${secret}`));
  return base64(new Uint8Array(signature));
}

/** 拼出最终要 fetch 的 URL（钉钉需要把签名加在 query 上） */
export async function buildWebhookUrl(
  rawUrl: string,
  secret: string,
  timestamp: number,
  kind: WebhookKind,
): Promise<string> {
  if (kind !== "dingtalk" || !secret.trim()) return rawUrl.trim();
  const sign = await dingtalkSign(secret.trim(), timestamp);
  const url = new URL(rawUrl.trim());
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  return url.toString();
}

/**
 * 卡片 → Markdown（钉钉 / 企业微信用）。
 *
 * 这两家的 markdown 是子集：钉钉支持 `###` 标题，企业微信不支持；
 * 两家都**不支持表格**，所以不用两列堆叠，改成
 *   一行加粗汇总 + 列表明细 + 列表备注
 * —— 比 `**指标**：值` 硬换行好看，也不会把备注挤成一行。
 */
export function cardToMarkdown(card: DigestCard, options: { heading?: boolean } = {}): string {
  const lines: string[] = [];
  const useHeading = options.heading !== false;

  lines.push(useHeading ? `### ${card.title}` : `**${card.title}**`, "");
  if (card.summary) lines.push(`**${card.summary}**`, "");
  // 明细与备注合成一个列表（中间空行在钉钉里会被当成两个列表，读起来断裂）
  for (const bullet of card.bullets) lines.push(`- ${bullet}`);
  for (const footnote of card.footnotes) lines.push(`- ${footnote}`);

  return lines.join("\n").trim();
}

/** 飞书交互卡片（两列 fields 是最接近表格的排版，且稳定支持） */
export function cardToFeishu(card: DigestCard): Record<string, unknown> {
  const elements: unknown[] = [];
  if (card.rows.length) {
    elements.push({
      tag: "div",
      fields: card.rows.map((row) => ({
        is_short: true,
        text: { tag: "lark_md", content: `**${row.label}**\n${row.value}` },
      })),
    });
  }
  if (card.bullets.length) {
    if (elements.length) elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `**明细**\n${card.bullets.map((item) => `- ${item}`).join("\n")}` },
    });
  }
  if (card.footnotes.length) {
    elements.push({ tag: "note", elements: [{ tag: "lark_md", content: card.footnotes.join(" · ") }] });
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      template: card.title.includes("周报") ? "indigo" : "blue",
      title: { tag: "plain_text", content: card.title },
    },
    elements,
  };
}

/** 各平台的包体 */
export function buildWebhookBody(kind: WebhookKind, message: WebhookMessage): string {
  const content = message.title ? `${message.title}\n${message.text}` : message.text;
  const card = message.card;

  if (card) {
    if (kind === "dingtalk") {
      return JSON.stringify({
        msgtype: "markdown",
        markdown: { title: card.title, text: cardToMarkdown(card, { heading: true }) },
        at: { isAtAll: false },
      });
    }
    if (kind === "wecom") {
      // 企业微信的 markdown 不支持 `###` 标题
      return JSON.stringify({ msgtype: "markdown", markdown: { content: cardToMarkdown(card, { heading: false }) } });
    }
    if (kind === "feishu") {
      return JSON.stringify({ msg_type: "interactive", card: cardToFeishu(card) });
    }
  }

  switch (kind) {
    case "dingtalk":
      return JSON.stringify({ msgtype: "text", text: { content }, at: { isAtAll: false } });
    case "wecom":
      return JSON.stringify({ msgtype: "text", text: { content } });
    case "feishu":
      return JSON.stringify({ msg_type: "text", content: { text: content } });
    default:
      // 通用：保持原有字段（自建服务可能已经在用），再加一个拼好的 text 方便直接展示
      return JSON.stringify({
        taskId: message.taskId ?? null,
        taskName: message.taskName ?? null,
        ok: false,
        message: message.text,
        text: content,
        at: message.at,
      });
  }
}

export async function buildWebhookPayload(
  rawUrl: string,
  secret: string,
  message: WebhookMessage,
  options: { kind?: WebhookKind; now?: number } = {},
): Promise<WebhookPayload> {
  const kind = options.kind ?? detectWebhookKind(rawUrl);
  const timestamp = options.now ?? Date.now();
  return {
    kind,
    url: await buildWebhookUrl(rawUrl, secret, timestamp, kind),
    body: buildWebhookBody(kind, message),
  };
}

export interface WebhookResult {
  ok: boolean;
  error?: string;
}

/**
 * 判断这次推送是否真的成功。
 * 钉钉 / 企业微信 / 飞书 都用 HTTP 200 + 业务错误码，必须读 body。
 */
export function parseWebhookResult(kind: WebhookKind, status: number, rawBody: string): WebhookResult {
  if (status < 200 || status >= 300) return { ok: false, error: `HTTP ${status}` };

  const body = rawBody.trim();
  if (!body) return { ok: true };

  let data: unknown = null;
  try {
    data = JSON.parse(body);
  } catch {
    return { ok: true }; // 非 JSON（自建服务返回纯文本）视为成功
  }
  if (!data || typeof data !== "object") return { ok: true };

  const record = data as Record<string, unknown>;
  if (kind === "dingtalk" || kind === "wecom") {
    const errcode = record.errcode;
    if (errcode !== undefined && errcode !== null && Number(errcode) !== 0) {
      return { ok: false, error: `${errcode}：${String(record.errmsg ?? "未知错误")}` };
    }
    return { ok: true };
  }
  if (kind === "feishu") {
    const code = record.code ?? record.StatusCode;
    if (code !== undefined && code !== null && Number(code) !== 0) {
      return { ok: false, error: `${code}：${String(record.msg ?? record.StatusMessage ?? "未知错误")}` };
    }
    return { ok: true };
  }
  if (record.ok === false) return { ok: false, error: String(record.error ?? "接收方返回 ok=false") };
  return { ok: true };
}
