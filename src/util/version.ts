/**
 * 版本号比较（只认 x.y.z，够用且好测）。
 *
 * 用在「新版本提示」上：拿 GitHub 最新 Release 和当前构建的版本比大小。
 */
export function parseVersion(value: string): [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? "").trim());
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** a 是否比 b 新（严格大于） */
export function isNewerVersion(a: string, b: string): boolean {
  const [a1, a2, a3] = parseVersion(a);
  const [b1, b2, b3] = parseVersion(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}
