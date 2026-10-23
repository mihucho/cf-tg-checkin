#!/usr/bin/env node
/**
 * 部署前自检：确认打包产物确实导出了 wrangler.jsonc 里声明的 Durable Object 类。
 *
 * 这道检查是为了挡住一类很坑的线上报错：
 *   "New version of script does not export class 'TgAgent' which is depended on by existing Durable Objects."
 * 出现它意味着「账号里已经有 TgAgent 的 DO，但这次上传的脚本里没有这个导出」——
 * 通常是上了错的产物（比如没构建、传了 dist/smoke.mjs、或者被 dashboard 的 Quick Edit 覆盖）。
 *
 * 用法：
 *   node scripts/check-bundle.mjs            # 检查
 *   node scripts/check-bundle.mjs --verbose  # additionally 打印所有导出名
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = process.cwd();

function readConfig() {
  const candidates = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
  for (const name of candidates) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    if (name.endsWith(".toml")) return { file, config: parseToml(raw) };
    // 去掉整行注释后按 JSON 解析（仓库里的 wrangler.jsonc 只用整行注释）
    const json = raw
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    return { file, config: JSON.parse(json) };
  }
  throw new Error("找不到 wrangler 配置文件（wrangler.jsonc / wrangler.toml）");
}

/** 只解析我们需要的少数 TOML 字段，够用就行 */
function parseToml(raw) {
  const main = /^main\s*=\s*"([^"]+)"/m.exec(raw)?.[1] ?? null;
  const classNames = [...raw.matchAll(/class_name\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
  const newSql = [...raw.matchAll(/new_sqlite_classes\s*=\s*\[([^\]]*)\]/g)].flatMap((match) =>
    [...match[1].matchAll(/"([^"]+)"/g)].map((inner) => inner[1]),
  );
  const newKv = [...raw.matchAll(/new_classes\s*=\s*\[([^\]]*)\]/g)].flatMap((match) =>
    [...match[1].matchAll(/"([^"]+)"/g)].map((inner) => inner[1]),
  );
  return {
    main,
    durable_objects: { bindings: classNames.map((class_name) => ({ class_name })) },
    migrations: [{ new_sqlite_classes: newSql, new_classes: newKv }],
  };
}

function exportNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const part of match[1].split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const alias = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(piece);
      names.add(alias ? alias[1] : piece.split(/\s+/)[0]);
    }
  }
  for (const match of source.matchAll(/\bexport\s+(?:default\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  if (/\bexport\s+default\b/.test(source)) names.add("default");
  return names;
}

const verbose = process.argv.includes("--verbose");

const { file, config } = readConfig();
const main = config.main ?? config.entrypoint;
if (!main) {
  console.error("✗ wrangler 配置里没有 main，无法检查打包产物");
  process.exit(1);
}

const bundlePath = path.join(root, main.replace(/^\.\//, ""));
if (!fs.existsSync(bundlePath)) {
  console.error(`✗ 打包产物不存在：${main}`);
  console.error("  先执行 `npm run build`（或直接 `npm run deploy`，wrangler 会自动构建）");
  process.exit(1);
}

const source = fs.readFileSync(bundlePath, "utf8");
const sizes = {
  raw: Buffer.byteLength(source),
  gzip: zlib.gzipSync(source, { level: 9 }).length,
};

const required = new Set([
  ...(config.durable_objects?.bindings ?? []).map((binding) => binding.class_name).filter(Boolean),
  ...(config.migrations ?? []).flatMap((migration) => [
    ...(migration.new_sqlite_classes ?? []),
    ...(migration.new_classes ?? []),
  ]),
]);

if (required.size === 0) {
  console.warn("! wrangler 配置里没有声明 Durable Object 类，跳过检查");
}

const exported = exportNames(source);
const missing = [...required].filter((name) => !exported.has(name));

console.log(`配置文件   ${path.basename(file)}`);
console.log(`入口产物   ${main}  (${(sizes.raw / 1024).toFixed(0)} KiB, gzip ${(sizes.gzip / 1024).toFixed(0)} KiB)`);
console.log(`需要导出   ${[...required].join(", ") || "（无）"}`);
if (verbose) console.log(`全部导出   ${[...exported].sort().join(", ")}`);

if (missing.length) {
  console.error("");
  console.error(`✗ 产物里缺少导出：${missing.join(", ")}`);
  console.error("");
  console.error("  这可能是因为：");
  console.error("  1. 部署了未构建 / 过期的产物（dist/ 是生成物，不要提交）");
  console.error("  2. 部署了错误的入口（例如 dist/smoke.mjs）");
  console.error("  3. 类名被改动，但没有加 rename-class / delete-class migration");
  console.error("");
  console.error("  修复：`npm run build` 后确认 `node scripts/check-bundle.mjs --verbose` 通过，再 `npm run deploy`。");
  process.exit(1);
}

if (sizes.gzip > 3 * 1024 * 1024) {
  console.warn(`! gzip 后 ${(sizes.gzip / 1024 / 1024).toFixed(2)} MiB，超过免费版 3 MiB 限制（付费版 10 MiB）`);
}

console.log("✓ 产物导出检查通过");
