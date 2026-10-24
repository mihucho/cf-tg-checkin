/** 设置对外输出时的脱敏（纯函数，便于测试） */
import type { Settings } from "./types";

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

/** Turnstile 的 Secret 永远不回传，只给一个"已配置"的布尔标记 */
export function redactSettings(settings: Settings): Settings {
  return {
    ...settings,
    turnstileSecretKey: "",
    turnstileSecretConfigured: Boolean(settings.turnstileSecretKey),
  };
}
