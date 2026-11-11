/**
 * 「有没有新版本」检查。
 *
 * 放在 Worker 而不是 DO：
 *  - Cloudflare 对 Durable Object 的代码更新是延后的（默认 deferred，最长 5 分钟），
 *    部署后的一小段时间里 DO 仍在跑旧构建，用它当「当前版本」会误报「有新版本」；
 *    Worker 自己就是刚部署的那份代码，版本信息只有它最准确。
 *  - 检查结果与 DO 里的任务/账号数据无关，不需要占用 DO 的串行执行队列。
 *
 * 缓存用 Cache API（按仓库 + 构建 ID 隔离，重新构建后旧键自然不会再被读到）：
 * 这是可重建的缓存，不属于「跨请求状态必须落 DO SQLite」的约束。
 */
import { BUILD } from "./version";
import { isNewerVersion } from "./util/version";
import type { Env } from "./env";

export interface UpdateInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  url: string | null;
}

const DEFAULT_REPO = "mihucho/cf-tg-checkin";
const SUCCESS_CACHE_SECONDS = 6 * 3600;
/** 没查到最新版本时只缓存几分钟，网络恢复后可以尽快重试 */
const FAILURE_CACHE_SECONDS = 5 * 60;
const FETCH_TIMEOUT_MS = 8000;

/** 只接受 `owner/repo`，避免把用户配置拼进奇怪的 URL */
export function repoOf(value?: string): string {
  const raw = (value ?? DEFAULT_REPO).trim() || DEFAULT_REPO;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) ? raw : DEFAULT_REPO;
}

/** 版本号只认 x.y.z 开头；Release tag 可能带 v 前缀 */
export function cleanVersion(value?: string | null): string | null {
  const text = String(value ?? "").trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+/.test(text) ? text : null;
}

/**
 * 合并两个来源：`main` 的 package.json 能覆盖未打 tag 的版本，
 * 最新 Release 提供更准确的链接；两者版本不同时取较新的。
 */
export function mergeUpdateSources(sources: {
  repo: string;
  current: string;
  packageVersion?: string | null;
  releaseTag?: string | null;
  releaseUrl?: string | null;
}): UpdateInfo {
  const pkg = cleanVersion(sources.packageVersion);
  const tag = cleanVersion(sources.releaseTag);
  const releaseUrl = /^https:\/\/github\.com\//i.test(sources.releaseUrl ?? "") ? sources.releaseUrl! : null;
  let latest = pkg;
  let url = pkg ? `https://github.com/${sources.repo}/blob/main/CHANGELOG.md` : null;

  if (tag && (!latest || isNewerVersion(tag, latest))) {
    latest = tag;
    url = releaseUrl || url;
  } else if (tag && tag === latest && releaseUrl) {
    url = releaseUrl;
  }

  return {
    current: sources.current,
    latest,
    hasUpdate: latest ? isNewerVersion(latest, sources.current) : false,
    url,
  };
}

async function fetchPackageVersion(repo: string): Promise<string | null> {
  try {
    const response = await fetch(`https://raw.githubusercontent.com/${repo}/main/package.json`, {
      headers: { "user-agent": "cf-tg-checkin", accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const pkg = (await response.json()) as { version?: string };
    return cleanVersion(pkg.version);
  } catch {
    return null;
  }
}

async function fetchLatestRelease(repo: string): Promise<{ tag: string; url: string | null } | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { "user-agent": "cf-tg-checkin", accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { tag_name?: string; html_url?: string };
    const tag = cleanVersion(data.tag_name);
    if (!tag) return null;
    return { tag, url: data.html_url ?? null };
  } catch {
    return null;
  }
}

/** refresh=true 时绕过缓存（「重新检查」按钮） */
export async function checkUpdate(env: Pick<Env, "GITHUB_REPO">, refresh: boolean): Promise<UpdateInfo> {
  const repo = repoOf(env.GITHUB_REPO);
  const cacheKey = new Request(
    `https://cf-tg-checkin.internal/update-check/${encodeURIComponent(repo)}/${encodeURIComponent(BUILD.buildId)}`,
    { method: "GET" },
  );

  if (!refresh) {
    try {
      const cached = await caches.default.match(cacheKey);
      if (cached) return (await cached.json()) as UpdateInfo;
    } catch {
      /* 缓存不可用就直接查 */
    }
  }

  const [packageVersion, release] = await Promise.all([fetchPackageVersion(repo), fetchLatestRelease(repo)]);
  const info = mergeUpdateSources({
    repo,
    current: BUILD.version,
    packageVersion,
    releaseTag: release?.tag,
    releaseUrl: release?.url,
  });

  try {
    await caches.default.put(
      cacheKey,
      new Response(JSON.stringify(info), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${info.latest ? SUCCESS_CACHE_SECONDS : FAILURE_CACHE_SECONDS}`,
        },
      }),
    );
  } catch {
    /* 缓存写失败不影响这次结果 */
  }

  return info;
}
