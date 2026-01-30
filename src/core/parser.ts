/**
 * Message event parsing utilities.
 * Uses Feishu native mention format throughout for compatibility.
 */

import type {
  MessageReceivedEvent,
  MessageMention,
  ParsedMessage,
  MentionInfo,
} from "../types/index.js";

// ============================================================================
// Content Parsing
// ============================================================================

/**
 * Parse message content based on message type.
 * Extracts text from JSON-wrapped content.
 */
export function parseMessageContent(content: string, messageType: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      messageType === "text" &&
      typeof parsed === "object" &&
      parsed !== null &&
      "text" in parsed
    ) {
      return String((parsed as { text: unknown }).text);
    }
    return content;
  } catch {
    return content;
  }
}

// ============================================================================
// Mention Detection
// ============================================================================

/**
 * Check if the bot was mentioned in a message.
 */
export function isBotMentioned(
  mentions: MessageMention[] | undefined,
  botOpenId: string | undefined
): boolean {
  if (!mentions || mentions.length === 0) {
    return false;
  }

  // If we don't know our bot's open_id, cannot determine if mentioned
  if (!botOpenId) {
    return false;
  }

  return mentions.some((m) => m.id.open_id === botOpenId);
}

/**
 * Process mentions in message content.
 * Removes bot mentions completely, preserves non-bot mentions in Feishu native format.
 *
 * Feishu native format: <at user_id="open_id">Name</at>
 */
export function stripMentions(
  text: string,
  mentions: MessageMention[] | undefined,
  botOpenId?: string
): string {
  if (!mentions || mentions.length === 0) {
    return text;
  }

  let result = text;
  for (const mention of mentions) {
    const mentionOpenId = mention.id.open_id;
    const isBotMention = botOpenId && mentionOpenId === botOpenId;

    if (isBotMention) {
      // Remove bot mentions entirely
      const namePattern = new RegExp(`@${escapeRegex(mention.name)}\\s*`, "g");
      result = result.replace(namePattern, "").trim();
      result = result.replace(new RegExp(escapeRegex(mention.key), "g"), "").trim();
    } else if (mentionOpenId) {
      // Replace with Feishu native format for non-bot mentions
      const replacement = `<at user_id="${mentionOpenId}">${mention.name}</at>`;
      const namePattern = new RegExp(`@${escapeRegex(mention.name)}`, "g");
      result = result.replace(namePattern, replacement);
      result = result.replace(new RegExp(escapeRegex(mention.key), "g"), replacement);
    } else {
      // Remove mentions without open_id
      const namePattern = new RegExp(`@${escapeRegex(mention.name)}\\s*`, "g");
      result = result.replace(namePattern, "").trim();
      result = result.replace(new RegExp(escapeRegex(mention.key), "g"), "").trim();
    }
  }

  return result;
}

/**
 * Extract non-bot mentions as structured MentionInfo array.
 */
export function extractMentions(
  mentions: MessageMention[] | undefined,
  botOpenId?: string
): MentionInfo[] {
  if (!mentions || mentions.length === 0) {
    return [];
  }

  const result: MentionInfo[] = [];
  for (const mention of mentions) {
    const mentionOpenId = mention.id.open_id;
    if (!mentionOpenId || (botOpenId && mentionOpenId === botOpenId)) {
      continue;
    }
    result.push({
      name: mention.name,
      openId: mentionOpenId,
    });
  }

  return result;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// Event Parsing
// ============================================================================

/**
 * Parse a raw message event into a standardized format.
 */
export function parseMessageEvent(event: MessageReceivedEvent, botOpenId?: string): ParsedMessage {
  const message = event.message;
  const sender = event.sender;

  const rawContent = parseMessageContent(message.content, message.message_type);
  const mentionedBot = isBotMentioned(message.mentions, botOpenId);
  const content = stripMentions(rawContent, message.mentions, botOpenId);
  const mentions = extractMentions(message.mentions, botOpenId);

  return {
    chatId: message.chat_id,
    messageId: message.message_id,
    senderId: sender.sender_id.user_id ?? sender.sender_id.open_id ?? "",
    senderOpenId: sender.sender_id.open_id ?? "",
    senderName: undefined,
    chatType: message.chat_type,
    mentionedBot,
    rootId: message.root_id ?? undefined,
    parentId: message.parent_id ?? undefined,
    content,
    contentType: message.message_type,
    mentions: mentions.length > 0 ? mentions : undefined,
  };
}

// ============================================================================
// Outbound Mention Formatting (Legacy Support)
// ============================================================================

/**
 * Convert @[Name](open_id) format to Feishu native <at user_id="open_id">Name</at> format.
 * This provides backward compatibility for any code still using the old format.
 *
 * Note: The preferred approach is to use Feishu native format directly.
 */
export function formatMentionsForFeishu(text: string): string {
  const mentionPattern = /@\[([^\]]+)\]\(([^)]+)\)/g;
  return text.replace(mentionPattern, (_match, name: string, openId: string) => {
    return `<at user_id="${openId}">${name}</at>`;
  });
}
