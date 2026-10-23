/** Worker 绑定 */
export interface Env {
  TG_AGENT: DurableObjectNamespace;
  ASSETS: Fetcher;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  /** Cloudflare Turnstile：站点 key（公开，会给前端）/ 密钥（secret，只用于校验） */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TZ_OFFSET?: string;
  /** 可选：只允许这些 Host 访问（逗号分隔），配合 Cloudflare Access 用 */
  ALLOWED_HOSTS?: string;
  /** 可选：DO 创建的区域提示（apac / enam / weur / eeur / me / afr / oc / sam） */
  DO_LOCATION_HINT?: string;
  /** 可选：用环境变量给 apiId / apiHash，省得在界面上填 */
  TG_API_ID?: string;
  TG_API_HASH?: string;
}
