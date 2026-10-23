/**
 * 构建信息。
 *
 * 版本号的唯一来源是 package.json 的 `version` 字段 —— 发版只改那一处，
 * build.mjs 会把它连同 git commit、构建时间一起注入到产物里。
 */
declare const __APP_VERSION__: string | undefined;
declare const __BUILD_ID__: string | undefined;
declare const __GIT_COMMIT__: string | undefined;

const version = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0-dev";
const buildId = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
const commit = typeof __GIT_COMMIT__ === "string" ? __GIT_COMMIT__ : "dev";

export const BUILD = { version, buildId, commit } as const;
