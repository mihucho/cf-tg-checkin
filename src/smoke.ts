/**
 * 冒烟测试 Worker：验证 teleproto + cloudflare:sockets 能不能在 workerd 里
 * 完成和 Telegram DC 的 auth key 握手（这一步不需要 api_id / 登录）。
 */
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { CloudflareTransport } from "./telegram/transport";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/smoke") return new Response("ok");
    const logs: string[] = [];
    try {
      const client = new TelegramClient(new StringSession(""), 2496, "0123456789abcdef0123456789abcdef", {
        connectionRetries: 1,
        useWSS: false,
        transport: new CloudflareTransport(),
        requestRetries: 1,
        timeout: 20,
      } as ConstructorParameters<typeof TelegramClient>[3]);
      logs.push("client created");
      await client.connect();
      logs.push("transport connected (auth key ok)");
      const dc = (client as unknown as { session: { getDC(): unknown } }).session.getDC();
      logs.push("dc=" + JSON.stringify(dc));
      await client.disconnect();
      logs.push("disconnected");
    } catch (error) {
      logs.push("ERROR: " + (error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error)));
    }
    return new Response(logs.join("\n---\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
