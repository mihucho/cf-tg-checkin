/** 设置对外输出时的脱敏（纯函数，便于测试） */
import type { AgentState, Settings } from "./types";
import { maskWebhookUrl } from "./notify/webhook";

/**
 * 管理员 ID 是否应该自动填成"当前登录账号"。
 * 只在「从没设置过」时填一次 —— 用户后来手动清空（或改成别的账号）就不再覆盖。
 */
export function shouldAutoFillAdminId(options: {
  adminUserId?: string | null;
  meId?: string | null;
  alreadyAutoFilled?: boolean;
}): boolean {
  if (options.adminUserId && options.adminUserId.trim()) return false;
  if (!options.meId) return false;
  if (options.alreadyAutoFilled) return false;
  return true;
}

/** 只显示首尾的脱敏：`7629…4acd` */
export function maskValue(value: string | number | null | undefined, keep = 4): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= keep * 2) return `${text.slice(0, 1)}***`;
  return `${text.slice(0, keep)}…${text.slice(-keep)}`;
}

/** 手机号脱敏：+8613****0000（保留国家码前缀和末 4 位） */
export function maskPhone(phone: string | null | undefined): string {
  const text = String(phone ?? "").trim();
  if (!text) return "";
  if (text.length <= 8) return "***";
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

/** 敏感值（Turnstile Secret、Webhook 加签密钥）永远不回传，只给"已配置"的布尔标记 */
export function redactSettings(settings: Settings): Settings {
  return {
    ...settings,
    turnstileSecretKey: "",
    turnstileSecretConfigured: Boolean(settings.turnstileSecretKey),
    notifyWebhookSecret: "",
    notifyWebhookSecretConfigured: Boolean(settings.notifyWebhookSecret),
  };
}

/**
 * 设置对外脱敏：所有响应（`/api/state`、`/api/settings`）都走这里，
 * 避免"保存成功后顺手把原始 Webhook 地址回显一遍"。
 */
export function redactSettingsForClient(settings: Settings): Settings {
  return {
    // 先走一遍 redactSettings（隐藏 Turnstile/加签密钥）
    ...redactSettings(settings),
    notifyWebhook: maskWebhookUrl(settings.notifyWebhook ?? ""),
    notifyWebhookConfigured: Boolean((settings.notifyWebhook ?? "").trim()),
    // 管理员 ID 本质是"自己的账号 id"，和 me.id 一样脱敏
    adminUserId: maskValue(settings.adminUserId, 3),
    adminUserIdConfigured: Boolean((settings.adminUserId ?? "").trim()),
  };
}

/**
 * `/api/state` 对外脱敏。
 *
 * 前端真正需要的都在：任务、日志、状态、以及"有没有配"的布尔标记。
 * 这些不该回给浏览器的：手机号、自己的账号 id、api_id、目标 access_hash、
 * Webhook 地址（里面带着 access_token / key）。
 */
export function redactState(state: AgentState): AgentState {
  const account = state.account;
  const settings = state.settings;

  const redactTarget = <T extends { accessHash?: string }>(target: T): T => {
    if (!target || !target.accessHash) return target;
    const { accessHash: _hidden, ...rest } = target;
    return rest as T;
  };

  return {
    ...state,
    account: {
      ...account,
      apiId: account.apiId ? (maskValue(account.apiId) as unknown as number) : null,
      phone: account.phone ? maskPhone(account.phone) : account.phone,
      me: account.me ? { ...account.me, id: maskValue(account.me.id, 3) } : account.me,
      pendingLogin: account.pendingLogin
        ? { ...account.pendingLogin, phone: maskPhone(account.pendingLogin.phone) }
        : account.pendingLogin,
    },
    settings: redactSettingsForClient(settings),
    tasks: state.tasks.map((task) => ({
      ...task,
      target: redactTarget(task.target),
      ...(task.targets ? { targets: task.targets.map((item) => redactTarget(item)) } : {}),
    })),
  };
}
