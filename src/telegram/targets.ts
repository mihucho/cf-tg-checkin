/**
 * 从一条消息里推断「签到目标」（要发给谁）。
 *
 * 用户表达"目标"的方式很多，这里统一抽干：
 *  1. 转发 / 分享来源（fwd_from.from_id）
 *  2. 联系人卡片（media.user_id）
 *  3. 内联机器人（via_bot_id）
 *  4. 消息发送者（仅在"不是我自己发的"时候才算）
 *  5. 文本 / 预览里的 t.me 链接
 *
 * 纯函数，不碰网络；解析出 peer 之后由 agent 用 client.getEntity 换成实体。
 */

export interface PeerRef {
  className: string;
  userId?: unknown;
  channelId?: unknown;
  chatId?: unknown;
}

export type MessageTargetHint =
  | { kind: "peer"; peer: PeerRef }
  | { kind: "link"; value: string }
  | { kind: "username"; value: string };

export interface MessageLike {
  out?: boolean;
  message?: string;
  fwdFrom?: { fromId?: PeerRef | null; fromName?: string };
  viaBotId?: unknown;
  media?: {
    className?: string;
    userId?: unknown;
    webpage?: { url?: string };
  };
  senderId?: PeerRef | null;
  entities?: Array<{
    className?: string;
    offset?: number;
    length?: number;
    url?: string;
  }>;
}

/** 收集消息里可能指向聊天的链接（网页预览 + 各类 URL 实体） */
export function collectLinks(message: MessageLike): string[] {
  const links: string[] = [];
  if (message.media?.webpage?.url) links.push(message.media.webpage.url);

  const text = message.message ?? "";
  for (const entity of message.entities ?? []) {
    const className = entity.className ?? "";
    if (!/Url/i.test(className)) continue;
    if (className === "MessageEntityTextUrl" && entity.url) links.push(entity.url);
    else if (typeof entity.offset === "number" && typeof entity.length === "number") {
      links.push(text.slice(entity.offset, entity.offset + entity.length));
    }
  }
  return links;
}

/** 从 `@name` / `https://t.me/name` / `t.me/name` 里取 username */
export function usernameFromLink(value: string): string | null {
  const trimmed = value.trim();
  const match = /^(?:https?:\/\/)?(?:t|telegram)\.me\/([A-Za-z0-9_]{3,})(?:[?#].*)?$/i.exec(trimmed);
  if (match) return match[1];
  const handle = /^@([A-Za-z0-9_]{3,})$/.exec(trimmed);
  return handle ? handle[1] : null;
}

/**
 * 从单条消息里提取目标线索。
 * @param allowSender 是否允许把"消息发送者"当目标：
 *   - 触发消息本身不能（发送者就是我自己）；
 *   - 被回复的那条可以（群里的机器人消息，发送者就是机器人）。
 */
export function messageTargetHint(
  message: MessageLike,
  options: { allowSender?: boolean } = {},
): MessageTargetHint | null {
  // 1. 转发 / 分享来源
  const forwarded = message.fwdFrom?.fromId;
  if (forwarded?.className) return { kind: "peer", peer: forwarded };

  // 2. 联系人 / 机器人卡片
  if (message.media?.userId) {
    return { kind: "peer", peer: { className: "PeerUser", userId: message.media.userId } };
  }

  // 3. 内联机器人（via_bot）
  if (message.viaBotId) {
    return { kind: "peer", peer: { className: "PeerUser", userId: message.viaBotId } };
  }

  // 4. 发送者（我自己发的不算）
  if (options.allowSender && !message.out && message.senderId?.className) {
    return { kind: "peer", peer: message.senderId };
  }

  // 5. 链接
  for (const link of collectLinks(message)) {
    const username = usernameFromLink(link);
    if (username) return { kind: "username", value: username };
    if (/^https?:\/\//i.test(link)) return { kind: "link", value: link };
  }

  return null;
}
