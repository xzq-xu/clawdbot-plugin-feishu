/**
 * Reply dispatcher for Feishu.
 * Creates a dispatcher that sends agent replies back to Feishu.
 */

import type { ClawdbotConfig, RuntimeEnv, ReplyPayload, PluginRuntime } from "clawdbot/plugin-sdk";
import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
} from "clawdbot/plugin-sdk";

import { getRuntime } from "./runtime.js";
import { sendTextMessage } from "../api/messages.js";
import { sendMedia } from "../api/media.js";
import { addReaction, removeReaction, Emoji } from "../api/reactions.js";
import { formatMentionsForFeishu } from "./parser.js";
import type { Config } from "../config/schema.js";

// ============================================================================
// Types
// ============================================================================

export interface CreateReplyDispatcherParams {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
}

interface TypingIndicatorState {
  messageId: string;
  emoji: string;
}

// ============================================================================
// File Reference Detection
// ============================================================================

/**
 * File reference format: ![name](file:///path) or ![name](https://url)
 * Similar to Markdown image syntax but with file:// protocol for local files.
 *
 * Examples:
 *   ![图片](file:///home/user/image.png)
 *   ![报告](file://./documents/report.pdf)
 *   ![Photo](https://example.com/photo.jpg)
 */
const FILE_REFERENCE_PATTERN = /!\[([^\]]*)\]\(((?:file:\/\/|https?:\/\/)[^)]+)\)/g;

interface FileReference {
  fullMatch: string;
  name: string;
  path: string;
}

/**
 * Extract file references from text.
 */
function extractFileReferences(text: string): FileReference[] {
  const refs: FileReference[] = [];
  let match;

  while ((match = FILE_REFERENCE_PATTERN.exec(text)) !== null) {
    refs.push({
      fullMatch: match[0],
      name: match[1] || "file",
      path: match[2] ?? "",
    });
  }

  // Reset regex lastIndex
  FILE_REFERENCE_PATTERN.lastIndex = 0;

  return refs;
}

/**
 * Convert file:// path to actual file path.
 */
function fileUrlToPath(fileUrl: string): string {
  if (fileUrl.startsWith("file://")) {
    const path = fileUrl.slice(7); // Remove "file://"

    // Handle file:///absolute/path (3 slashes = absolute)
    // Handle file://./relative/path (2 slashes = relative)
    // Handle file://~/home/path (2 slashes = home)

    if (path.startsWith("/")) {
      // Absolute path: file:///home/user/file.png -> /home/user/file.png
      return path;
    } else if (path.startsWith("./") || path.startsWith("../")) {
      // Relative path: file://./path -> ./path
      return path;
    } else if (path.startsWith("~")) {
      // Home path: file://~/path -> ~/path
      return path;
    } else {
      // Default: treat as relative
      return "./" + path;
    }
  }

  // HTTP(S) URL - return as-is
  return fileUrl;
}

// ============================================================================
// Reply Dispatcher
// ============================================================================

export function createReplyDispatcher(params: CreateReplyDispatcherParams) {
  const core = getRuntime() as PluginRuntime;
  const { cfg, agentId, chatId, replyToMessageId } = params;
  const feishuCfg = cfg.channels?.feishu as Config | undefined;

  const prefixContext = createReplyPrefixContext({
    cfg,
    agentId,
  });

  // Typing indicator using reactions
  let typingState: TypingIndicatorState | null = null;

  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!replyToMessageId || !feishuCfg) return;
      try {
        const reactionId = await addReaction(feishuCfg, {
          messageId: replyToMessageId,
          emojiType: Emoji.TYPING,
        });
        typingState = { messageId: replyToMessageId, emoji: reactionId };
        params.runtime.log?.(`Added typing indicator reaction`);
      } catch (err) {
        params.runtime.log?.(`Failed to add typing reaction: ${String(err)}`);
      }
    },
    stop: async () => {
      if (!typingState || !feishuCfg) return;
      try {
        await removeReaction(feishuCfg, {
          messageId: typingState.messageId,
          reactionId: typingState.emoji,
        });
        typingState = null;
        params.runtime.log?.(`Removed typing indicator reaction`);
      } catch (err) {
        params.runtime.log?.(`Failed to remove typing reaction: ${String(err)}`);
      }
    },
    onStartError: (err) => {
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      });
    },
    onStopError: (err) => {
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      });
    },
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit({
    cfg,
    channel: "feishu",
    defaultLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: typingCallbacks.onReplyStart,
      deliver: async (payload: ReplyPayload) => {
        params.runtime.log?.(`Deliver called: text=${payload.text?.slice(0, 100)}`);
        const text = payload.text ?? "";
        if (!text.trim()) {
          params.runtime.log?.(`Deliver: empty text, skipping`);
          return;
        }

        if (!feishuCfg) {
          params.runtime.error?.(`Deliver: feishuCfg not available`);
          return;
        }

        // Extract file references from text
        const fileRefs = extractFileReferences(text);

        if (fileRefs.length > 0) {
          params.runtime.log?.(`Deliver: found ${fileRefs.length} file reference(s)`);

          // Remove file references from text
          let remainingText = text;
          for (const ref of fileRefs) {
            remainingText = remainingText.replace(ref.fullMatch, "").trim();
          }

          // Send remaining text first if any
          if (remainingText.trim()) {
            const converted = core.channel.text.convertMarkdownTables(remainingText, tableMode);
            const formattedText = formatMentionsForFeishu(converted);
            const chunks = core.channel.text.chunkTextWithMode(
              formattedText,
              textChunkLimit,
              chunkMode
            );

            params.runtime.log?.(`Deliver: sending ${chunks.length} text chunks`);
            for (const chunk of chunks) {
              await sendTextMessage(feishuCfg, {
                to: chatId,
                text: chunk,
                replyToMessageId,
              });
            }
          }

          // Send each file
          for (const ref of fileRefs) {
            const filePath = fileUrlToPath(ref.path);
            try {
              params.runtime.log?.(`Deliver: sending file "${ref.name}" from ${filePath}`);
              await sendMedia(feishuCfg, {
                to: chatId,
                mediaUrl: filePath,
                fileName: ref.name,
                replyToMessageId,
              });
              params.runtime.log?.(`Deliver: file "${ref.name}" sent successfully`);
            } catch (err) {
              params.runtime.error?.(`Deliver: sendMedia failed for "${ref.name}": ${String(err)}`);
              // Fallback to text with file info
              await sendTextMessage(feishuCfg, {
                to: chatId,
                text: `📎 ${ref.name}: ${filePath}`,
                replyToMessageId,
              });
            }
          }
          return;
        }

        // Regular text delivery (no file references)
        const converted = core.channel.text.convertMarkdownTables(text, tableMode);
        const formattedText = formatMentionsForFeishu(converted);
        const chunks = core.channel.text.chunkTextWithMode(
          formattedText,
          textChunkLimit,
          chunkMode
        );

        params.runtime.log?.(`Deliver: sending ${chunks.length} chunks to ${chatId}`);
        for (const chunk of chunks) {
          await sendTextMessage(feishuCfg, {
            to: chatId,
            text: chunk,
            replyToMessageId,
          });
        }
      },
      onError: (err, info) => {
        params.runtime.error?.(`${info.kind} reply failed: ${String(err)}`);
        typingCallbacks.onIdle?.();
      },
      onIdle: typingCallbacks.onIdle,
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
    },
    markDispatchIdle,
  };
}
