/** stub for node-localstorage（只有 StoreSession 用，我们只用 StringSession / DO storage） */
export class LocalStorage {
  constructor() {
    throw new Error("node-localstorage is not available in Cloudflare Workers; use StringSession");
  }
}
export default { LocalStorage };
