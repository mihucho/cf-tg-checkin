/** 设置对外输出时的脱敏（纯函数，便于测试） */
import type { Settings } from "./types";

/** Turnstile 的 Secret 永远不回传，只给一个"已配置"的布尔标记 */
export function redactSettings(settings: Settings): Settings {
  return {
    ...settings,
    turnstileSecretKey: "",
    turnstileSecretConfigured: Boolean(settings.turnstileSecretKey),
  };
}
