/** stub for path / node:path / socks */
export const join = (...parts: string[]) => parts.filter(Boolean).join("/");
export const resolve = join;
export const dirname = (p: string) => p.split("/").slice(0, -1).join("/") || ".";
export const basename = (p: string) => p.split("/").pop() ?? "";
export const sep = "/";
export default { join, resolve, dirname, basename, sep };
