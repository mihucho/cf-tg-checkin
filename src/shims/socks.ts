/** stub for socks（只有 SocksTransport 会用到，Workers 里不用） */
export class SocksClient {
  static createConnection() {
    throw new Error("socks is not available in Cloudflare Workers; use CloudflareTransport");
  }
}
export default { SocksClient };
