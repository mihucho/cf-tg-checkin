/** stub for node:net —— Workers 里没有，NetSocket 只在我们不走的分支里用到它 */
export class Socket {
  constructor() {
    throw new Error("node:net Socket is not available in Cloudflare Workers; use CloudflareTransport");
  }
}
export class Server {}
export const createServer = () => {
  throw new Error("node:net createServer is not available in Cloudflare Workers");
};
export const connect = () => {
  throw new Error("node:net connect is not available in Cloudflare Workers");
};
export const isIP = () => 0;
export class BlockList {}
export default { Socket, Server, createServer, connect, isIP, BlockList };
