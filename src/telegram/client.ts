/**
 * teleproto 客户端工厂。
 *
 * 注意：teleproto 默认走 node:net，这里换成 CloudflareTransport —— 用 workers 的
 * cloudflare:sockets 直连 Telegram DC。session 用 StringSession 存在 DO 的 SQLite 里。
 */
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { CloudflareTransport } from "./transport";

export interface TgCredentials {
  apiId: number;
  apiHash: string;
  session: string;
}

export function createTgClient(creds: TgCredentials): TelegramClient {
  const session = new StringSession(creds.session?.trim() ? creds.session : "");
  return new TelegramClient(session, Number(creds.apiId), creds.apiHash, {
    transport: new CloudflareTransport(),
    connectionRetries: 1,
    requestRetries: 1,
    retryDelay: 500,
    autoReconnect: false,
    timeout: 15,
    floodSleepThreshold: 0,
    deviceModel: "CF Worker",
    systemVersion: "1.0.0",
    appVersion: "0.1.0",
    langCode: "zh",
    systemLangCode: "zh-CN",
    useWSS: false,
  } as ConstructorParameters<typeof TelegramClient>[3]);
}

/** teleproto 的错误对象通常带 errorMessage 字段 */
export function errorMessage(error: unknown): string {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  const candidate = error as { errorMessage?: string; message?: string };
  return candidate.errorMessage ?? candidate.message ?? String(error);
}
