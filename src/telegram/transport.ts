/**
 * 自定义 Transport：让 teleproto 通过 Cloudflare TCP sockets 连接 Telegram。
 *
 * teleproto 内置 TcpTransport（node:net）/ WebSocketTransport / SocksTransport /
 * MTProxyTransport，都不适用于 Workers；但 Transport 是公开可扩展的，
 * 只需要返回 { connection, socket } —— connection 决定 MTProto 封包格式，
 * socket 决定字节流怎么走。
 */
import { Transport, ConnectionTCPObfuscated } from "teleproto/network";
import type { Connection } from "teleproto/network/connection";
import type { SocketFactory } from "teleproto/network/transport/socket/types";
import { CloudflareSocketFactory } from "./socket";

export interface ResolvedTransport {
  connection: typeof Connection;
  socket: SocketFactory;
}

export class CloudflareTransport extends Transport {
  resolve(connection?: typeof Connection) {
    return {
      connection: connection ?? ConnectionTCPObfuscated,
      socket: CloudflareSocketFactory,
    } as unknown as ReturnType<Transport["resolve"]>;
  }
}
