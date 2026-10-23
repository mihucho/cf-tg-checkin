/** Worker 绑定 */
export interface Env {
  TG_AGENT: DurableObjectNamespace;
  ASSETS: Fetcher;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  TZ_OFFSET?: string;
  /** 可选：用环境变量给 apiId / apiHash，省得在界面上填 */
  TG_API_ID?: string;
  TG_API_HASH?: string;
}
