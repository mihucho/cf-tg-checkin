#!/usr/bin/env node
/**
 * 用 esbuild 打包 Worker。
 *
 * 为什么不用 wrangler 自带打包：
 *  1. teleproto 是 Node 库，`require("node:net")` / `fs` / `path` 在 Workers 里不存在，
 *     需要换成桩（真正的网络走 cloudflare:sockets）。
 *  2. teleproto 里大量 `__importDefault(require("node:zlib"))` 这种包了一层的 require，
 *     esbuild 在 ESM 输出里没法把它变成静态 import，运行时会抛
 *     "Dynamic require of node:xxx is not supported"。所以这里把每个 node 内建模块
 *     重定向到一个虚拟模块（`import * as shim from "node:xxx"; export * ...`），
 *     让真正的 `node:xxx` 变成顶层静态 import，交给 workerd 的 nodejs_compat。
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { argv, cwd } from "node:process";
import { execFileSync } from "node:child_process";

/** 构建戳：发布后可以用 /api/version 确认线上跑的是哪一版 */
function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
const BUILD_ID = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const GIT_COMMIT = gitCommit();
/** 版本号的唯一来源是 package.json（发版时只改这一处） */
const APP_VERSION = JSON.parse(fs.readFileSync("package.json", "utf8")).version;

const smoke = argv.includes("--smoke");
const test = argv.includes("--test");
const watch = argv.includes("--watch");

/** 走桩实现的模块（Workers 里没有 / 不需要） */
const stubs = {
  net: "src/shims/net.ts",
  "node:net": "src/shims/net.ts",
  fs: "src/shims/fs.ts",
  "node:fs": "src/shims/fs.ts",
  path: "src/shims/path.ts",
  "node:path": "src/shims/path.ts",
  socks: "src/shims/socks.ts",
  "node-localstorage": "src/shims/node-localstorage.ts",
};

/** 裸内建模块名 -> 视作 node:xxx */
const nodeBuiltins = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "dns",
  "events",
  "http",
  "https",
  "os",
  "perf_hooks",
  "process",
  "querystring",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "url",
  "util",
  "zlib",
]);

/** @type {esbuild.Plugin} */
const nodeCompatPlugin = {
  name: "node-compat",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const stub = stubs[args.path];
      if (stub) return { path: path.resolve(cwd(), stub) };

      const bare = args.path.startsWith("node:") ? args.path.slice(5) : args.path;
      const isNodeModule = args.path.startsWith("node:") || nodeBuiltins.has(args.path);
      if (!isNodeModule) return undefined;

      const spec = `node:${bare.split("/")[0]}${args.path.includes("/") && !args.path.startsWith("node:") ? "" : ""}`;
      // 子路径（node:timers/promises）原样保留
      const finalSpec = args.path.startsWith("node:") ? args.path : `node:${args.path}`;
      void spec;
      if (args.pluginData === "node-shim") {
        return { path: finalSpec, external: true };
      }
      return { path: finalSpec, namespace: "node-shim" };
    });

    build.onLoad({ filter: /.*/, namespace: "node-shim" }, (args) => {
      const spec = JSON.stringify(args.path);
      return {
        contents: [
          `import * as shimNamespace from ${spec};`,
          `export * from ${spec};`,
          `export default shimNamespace;`,
        ].join("\n"),
        loader: "js",
        resolveDir: cwd(),
        pluginData: "node-shim",
      };
    });
  },
};

/**
 * workerd 不能 eval / new Function，teleproto 却用 new Function 生成 TL 字段读写函数，
 * 打包时给该文件追加一份解释执行实现覆盖原导出。
 */
const fieldCodecPatch = fs.readFileSync(new URL("./build/patches/fieldCodec.js", import.meta.url), "utf8");
const noEvalPlugin = {
  name: "teleproto-no-eval",
  setup(build) {
    build.onLoad({ filter: /teleproto[\\/]tl[\\/]runtime[\\/]fieldCodec\.js$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, "utf8");
      return { contents: source + "\n" + fieldCodecPatch, loader: "js" };
    });
  },
};

if (test) {
  // 测试跑在 Node 里，cloudflare:sockets 不可用 —— 打个桩即可（单测不碰网络）
  const stubCloudflare = {
    name: "stub-cloudflare-modules",
    setup(build) {
      build.onResolve({ filter: /^cloudflare:/ }, (args) => ({ path: args.path, namespace: "cf-stub" }));
      build.onLoad({ filter: /.*/, namespace: "cf-stub" }, () => ({
        contents: "export const connect = () => { throw new Error('cloudflare:sockets 在单测环境不可用'); };",
        loader: "js",
      }));
    },
  };
  await esbuild.build({
    entryPoints: ["tests/index.test.ts"],
    outfile: "dist/test.cjs",
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    plugins: [stubCloudflare],
    logLevel: "warning",
  });
  process.exit(0);
}

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: [smoke ? "src/smoke.ts" : "src/index.ts"],
  outfile: smoke ? "dist/smoke.mjs" : "dist/worker.mjs",
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["worker", "browser", "import", "default"],
  sourcemap: true,
  minify: !smoke,
  external: ["cloudflare:sockets", "cloudflare:workers"],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_ID__: JSON.stringify(BUILD_ID),
    __GIT_COMMIT__: JSON.stringify(GIT_COMMIT),
  },
  plugins: [nodeCompatPlugin, noEvalPlugin],
  logLevel: "info",
  banner: { js: "// generated by build.mjs — do not edit" },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching…");
} else {
  await esbuild.build(options);
}
