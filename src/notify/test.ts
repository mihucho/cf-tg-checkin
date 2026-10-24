/**
 * 通知测试：把当前配置的通道真实打一遍，用来验证「地址 / 加签 / 关键词」对不对。
 *
 * 测试消息会故意用**日报的卡片格式**，这样点一下就能看到真实排版（Markdown 还是纯文本），
 * 而不是收到一条和正式通知长得不一样的样例。
 */
import type { Settings } from "../types";
import { NOTIFY_EVENTS } from "./events";
import type { DigestCard } from "./digest";

export const CHANNEL_LABELS: Record<string, string> = {
  dingtalk: "钉钉",
  wecom: "企业微信",
  feishu: "飞书",
  generic: "通用 JSON",
};

export interface TestMessage {
  title: string;
  text: string;
  card: DigestCard;
}

/** 配置摘要里用的人话（测试通知自己也带这些，收到就知道发的是哪套配置） */
export function describeNotifySetup(settings: Settings): string[] {
  const lines: string[] = [];
  const kind = settings.notifyWebhookKind ?? "generic";
  if ((settings.notifyWebhook ?? "").trim()) {
    lines.push(`Webhook：${CHANNEL_LABELS[kind] ?? kind}${settings.notifyWebhookSecret ? "（已配加签）" : ""}`);
  } else {
    lines.push("Webhook：未配置");
  }
  lines.push(`Telegram 私聊：${settings.notifyOnFailure !== false ? "开" : "关"}`);

  const selected = settings.notifyEvents ?? [];
  const labels = NOTIFY_EVENTS.filter((item) => selected.includes(item.id)).map((item) => item.label);
  lines.push(`已勾选通知：${labels.length ? labels.join("、") : "（一个都没勾，正式通知不会发）"}`);
  return lines;
}

export function buildTestMessage(settings: Settings): TestMessage {
  const summary = describeNotifySetup(settings);
  const rows = summary.map((line) => {
    const [label, ...rest] = line.split("：");
    return { label: label ?? "", value: rest.join("：") || "—" };
  });
  const title = "🧪 通知测试";
  const text = [
    "这是一条测试通知，收到说明推送链路是通的。",
    ...summary,
    "正式通知只在勾选的事件发生时推送。",
  ].join("\n");

  return {
    title,
    text,
    card: {
      title,
      rows,
      bullets: ["如果你看到了这条消息，说明地址、加签、关键词都配对了"],
      footnotes: ["来自 TG 签到台 · 通知测试"],
    },
  };
}
