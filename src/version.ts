/** 构建信息（由 build.mjs 通过 esbuild define 注入） */
declare const __BUILD_ID__: string | undefined;
declare const __GIT_COMMIT__: string | undefined;

const buildId = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
const commit = typeof __GIT_COMMIT__ === "string" ? __GIT_COMMIT__ : "dev";

export const BUILD = { buildId, commit } as const;
