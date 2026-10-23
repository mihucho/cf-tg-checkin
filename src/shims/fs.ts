/** stub for fs / node:fs */
const unsupported = (name: string) => () => {
  throw new Error(`${name} is not available in Cloudflare Workers`);
};
export const readFileSync = unsupported("fs.readFileSync");
export const writeFileSync = unsupported("fs.writeFileSync");
export const existsSync = () => false;
export const mkdirSync = unsupported("fs.mkdirSync");
export const promises = {};
export default { readFileSync, writeFileSync, existsSync, mkdirSync, promises };
