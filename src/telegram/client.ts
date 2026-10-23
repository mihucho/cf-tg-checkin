/**
 * teleproto 客户端工厂。
 *
 * 注意：teleproto 默认走 node:net，这里换成 CloudflareTransport —— 用 workers 的
 * cloudflare:sockets 直连 Telegram DC。session 用 StringSession 存在 DO 的 SQLite 里。
 */
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { CloudflareTransport } from "./transport";
import { BUILD } from "../version";

export interface TgCredentials {
  apiId: number;
  apiHash: string;
  session: string;
}

/**
 * Telegram 官方 DC 种子地址（与 teleproto 内置表一致）。
 * 只有「登录阶段被要求迁移」时才兜底用，正常情况下地址从 help.getConfig 拿。
 */
export const DC_SEEDS: Record<number, string> = {
  1: "149.154.175.50",
  2: "149.154.167.51",
  3: "149.154.175.100",
  4: "149.154.167.91",
  5: "149.154.171.5",
};

const DC_PORT = 443;

function clientOptions() {
  return {
    transport: new CloudflareTransport(),
    connectionRetries: 3,
    // 注意：teleproto 的重试循环连 DC 迁移 / msg_wait / flood_wait 一起兜，
    // 设成 1 等于关掉所有自愈（会直接把 PHONE_MIGRATE_n 抛给调用方）
    requestRetries: 5,
    retryDelay: 500,
    autoReconnect: false,
    timeout: 15,
    floodSleepThreshold: 0,
    deviceModel: "CF Worker",
    systemVersion: "1.0.0",
    appVersion: BUILD.version,
    langCode: "zh",
    systemLangCode: "zh-CN",
    useWSS: false,
  } as ConstructorParameters<typeof TelegramClient>[3];
}

export function createTgClient(creds: TgCredentials): TelegramClient {
  const session = new StringSession(creds.session?.trim() ? creds.session : "");
  return new TelegramClient(session, Number(creds.apiId), creds.apiHash, clientOptions());
}

/**
 * 在指定 DC 上开一个新连接（auth key 会在该 DC 上重新协商）。
 * 用于登录阶段收到 `PHONE_MIGRATE_n` / `NETWORK_MIGRATE_n` 时重试：
 * 账号归属另一个 DC 时，验证码必须在该 DC 上请求。
 */
export function createTgClientOnDc(
  creds: Pick<TgCredentials, "apiId" | "apiHash">,
  dcId: number,
  address?: string,
): TelegramClient {
  const session = new StringSession("");
  session.setDC(dcId, address || DC_SEEDS[dcId] || DC_SEEDS[2], DC_PORT);
  return new TelegramClient(session, Number(creds.apiId), creds.apiHash, clientOptions());
}

/** 从 `PHONE_MIGRATE_5` / `NETWORK_MIGRATE_4` 这类错误里取出目标 DC */
export function migrateDcFromError(error: unknown): number | null {
  const match = /^(?:PHONE|NETWORK)_MIGRATE_(\d+)$/.exec(errorMessage(error));
  return match ? Number(match[1]) : null;
}

/** teleproto 的错误对象通常带 errorMessage 字段 */
export function errorMessage(error: unknown): string {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  const candidate = error as { errorMessage?: string; message?: string };
  return candidate.errorMessage ?? candidate.message ?? String(error);
}
