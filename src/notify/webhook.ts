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

/** 卡片里的两列指标渲染成 Markdown（钉钉/企微的 markdown 不支持表格，用加粗行代替） */
export function cardToMarkdown(card: DigestCard): string {
  const parts: string[] = [`### ${card.title}`];
  if (card.rows.length) parts.push("");
  for (const row of card.rows) {
    parts.push(`**${row.label}**：${row.value}  `);
  }
  if (card.bullets.length) {
    parts.push("", "**明细**");
    for (const item of card.bullets) parts.push(`- ${item}`);
  }
  if (card.footnotes.length) {
    parts.push("", `> ${card.footnotes.join(" · ")}`);
  }
  return parts.join("\n").trim();
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
        markdown: { title: card.title, text: cardToMarkdown(card) },
        at: { isAtAll: false },
      });
    }
    if (kind === "wecom") {
      return JSON.stringify({ msgtype: "markdown", markdown: { content: cardToMarkdown(card) } });
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
