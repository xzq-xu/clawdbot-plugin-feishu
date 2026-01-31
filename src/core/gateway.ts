/**
 * WebSocket gateway for real-time Feishu events.
 * Includes automatic reconnection with exponential backoff.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "openclaw/plugin-sdk";
import type { Config } from "../config/schema.js";
import type { MessageReceivedEvent, BotAddedEvent, BotRemovedEvent } from "../types/index.js";
import { createWsClient, probeConnection } from "../api/client.js";
import { handleMessage, createBatchFlushHandler } from "./handler.js";
import { BatchProcessor } from "./batch-processor.js";

// ============================================================================
// Reconnection Configuration
// ============================================================================

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 60000;
const RECONNECT_MAX_ATTEMPTS = 20;

// ============================================================================
// Event Deduplication & Message Watermark
// ============================================================================

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours (Feishu's event_id uniqueness window)
const DEDUP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Cleanup every hour

// Watermark: track the latest message create_time per chat to filter stale messages on reconnect
const chatWatermarks = new Map<string, number>();

/**
 * Check if message is stale based on watermark.
 * Returns true if message should be skipped.
 */
function isStaleMessage(chatId: string, createTime: number): boolean {
  const watermark = chatWatermarks.get(chatId) ?? 0;
  return createTime <= watermark;
}

/**
 * Update watermark for a chat after successfully processing a message.
 */
function updateWatermark(chatId: string, createTime: number): void {
  const current = chatWatermarks.get(chatId) ?? 0;
  if (createTime > current) {
    chatWatermarks.set(chatId, createTime);
  }
}

interface DedupEntry {
  timestamp: number;
}

const processedEvents = new Map<string, DedupEntry>();
let dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Check if an event has already been processed.
 * Returns true if duplicate (should skip), false if new (should process).
 */
function isDuplicateEvent(eventId: string): boolean {
  const existing = processedEvents.get(eventId);
  if (existing) {
    return true;
  }
  // Mark as processed
  processedEvents.set(eventId, { timestamp: Date.now() });
  return false;
}

/**
 * Clean up old dedup entries to prevent memory leak.
 */
function cleanupDedupEntries(): void {
  const now = Date.now();
  const cutoff = now - DEDUP_WINDOW_MS;
  for (const [eventId, entry] of processedEvents) {
    if (entry.timestamp < cutoff) {
      processedEvents.delete(eventId);
    }
  }
}

/**
 * Start the dedup cleanup timer.
 */
function startDedupCleanup(): void {
  if (dedupCleanupTimer) return;
  dedupCleanupTimer = setInterval(cleanupDedupEntries, DEDUP_CLEANUP_INTERVAL_MS);
}

/**
 * Stop the dedup cleanup timer.
 */
function stopDedupCleanup(): void {
  if (dedupCleanupTimer) {
    clearInterval(dedupCleanupTimer);
    dedupCleanupTimer = null;
  }
  processedEvents.clear();
}

// ============================================================================
// Per-Chat Message Queue (Serial Processing)
// ============================================================================

interface QueuedMessage {
  event: MessageReceivedEvent;
  handler: () => Promise<void>;
}

interface ChatQueue {
  messages: QueuedMessage[];
  processing: boolean;
}

const chatQueues = new Map<string, ChatQueue>();

/**
 * Enqueue a message for serial processing within its chat.
 * Messages in the same chat are processed one at a time.
 * Different chats can process in parallel.
 */
function enqueueMessage(
  chatId: string,
  event: MessageReceivedEvent,
  handler: () => Promise<void>,
  logger: { log: (msg: string) => void; error: (msg: string) => void }
): void {
  let queue = chatQueues.get(chatId);
  if (!queue) {
    queue = { messages: [], processing: false };
    chatQueues.set(chatId, queue);
  }

  queue.messages.push({ event, handler });
  logger.log(`Gateway: message queued for chat ${chatId} (queue size: ${queue.messages.length})`);

  // Start processing if not already running
  if (!queue.processing) {
    processQueue(chatId, logger);
  }
}

/**
 * Process messages in a chat queue serially.
 */
async function processQueue(
  chatId: string,
  logger: { log: (msg: string) => void; error: (msg: string) => void }
): Promise<void> {
  const queue = chatQueues.get(chatId);
  if (!queue || queue.processing) return;

  queue.processing = true;
  logger.log(`Gateway: starting queue processing for chat ${chatId}`);

  while (queue.messages.length > 0) {
    const item = queue.messages.shift();
    if (item) {
      try {
        await item.handler();
      } catch (err) {
        logger.error(`Gateway: error processing queued message: ${String(err)}`);
      }
    }
  }

  queue.processing = false;
  logger.log(`Gateway: queue processing completed for chat ${chatId}`);

  // Clean up empty queues
  if (queue.messages.length === 0) {
    chatQueues.delete(chatId);
  }
}

/**
 * Clear all chat queues (for shutdown).
 */
function clearAllQueues(): void {
  chatQueues.clear();
}

// ============================================================================
// Types
// ============================================================================

export interface GatewayOptions {
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}

export interface GatewayState {
  botOpenId: string | undefined;
  botName: string | undefined;
  wsClient: Lark.WSClient | null;
  chatHistories: Map<string, HistoryEntry[]>;
  batchProcessor: BatchProcessor | null;
  isReconnecting: boolean;
  reconnectAttempts: number;
  shouldStop: boolean;
}

// ============================================================================
// Gateway State
// ============================================================================

const state: GatewayState = {
  botName: undefined,
  botOpenId: undefined,
  wsClient: null,
  chatHistories: new Map(),
  batchProcessor: null,
  isReconnecting: false,
  reconnectAttempts: 0,
  shouldStop: false,
};

export function getBotName(): string | undefined {
  return state.botName;
}

export function setBotInfo(openId: string | undefined, name: string | undefined): void {
  state.botOpenId = openId;
  state.botName = name;
}

export function getBotOpenId(): string | undefined {
  return state.botOpenId;
}

// ============================================================================
// Reconnection Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateBackoffDelay(attempt: number): number {
  const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, RECONNECT_MAX_DELAY_MS);
}

// ============================================================================
// Gateway Lifecycle
// ============================================================================

export async function startGateway(options: GatewayOptions): Promise<void> {
  const { cfg, runtime, abortSignal } = options;
  const feishuCfg = cfg.channels?.feishu as Config | undefined;
  const log = (msg: string) => runtime?.log?.(msg);
  const error = (msg: string) => runtime?.error?.(msg);

  if (!feishuCfg) {
    throw new Error("Feishu not configured");
  }

  // Reset state
  state.shouldStop = false;
  state.isReconnecting = false;
  state.reconnectAttempts = 0;

  try {
    const probeResult = await probeConnection(feishuCfg);
    if (probeResult.ok && probeResult.botOpenId) {
      state.botOpenId = probeResult.botOpenId;
      state.botName = probeResult.botName;
      log(`Gateway: bot identity resolved: ${state.botName} (${state.botOpenId})`);
    } else {
      log(`Gateway: probe failed or no bot info: ${probeResult.error ?? "unknown"}`);
    }
  } catch (err) {
    log(`Gateway: probe error: ${String(err)}`);
  }

  const onFlush = createBatchFlushHandler({
    cfg,
    runtime,
    chatHistories: state.chatHistories,
  });

  state.batchProcessor = new BatchProcessor({
    cfg,
    runtime,
    chatHistories: state.chatHistories,
    botOpenId: state.botOpenId,
    botName: state.botName,
    autoReply: feishuCfg?.autoReply,
    onFlush,
  });

  // Create event dispatcher (shared across reconnections)
  const eventDispatcher = new Lark.EventDispatcher({});

  // Start dedup cleanup timer
  startDedupCleanup();

  // Max age for messages (5 minutes) - skip messages older than this
  const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;

  eventDispatcher.register({
    "im.message.receive_v1": async (data: unknown) => {
      // IMPORTANT: Feishu requires event handlers to complete within 3 seconds,
      // otherwise it triggers a retry/re-push mechanism. We must return quickly
      // and process the message asynchronously (fire-and-forget).
      // See: https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-events

      const event = data as MessageReceivedEvent;

      // Deduplication: skip if event already processed
      const dedupKey = event.event_id ?? event.message?.message_id;
      if (dedupKey && isDuplicateEvent(dedupKey)) {
        log(`Gateway: skipping duplicate event ${dedupKey}`);
        return; // Return quickly to ACK
      }

      const chatId = event.message?.chat_id;
      const messageCreateTime = Number(event.message?.create_time);

      // Watermark check: skip messages older than the last processed message for this chat
      // This handles reconnection replays where Feishu re-sends unacknowledged messages
      if (chatId && messageCreateTime && isStaleMessage(chatId, messageCreateTime)) {
        log(`Gateway: skipping stale message (watermark filter, chat=${chatId})`);
        return; // Return quickly to ACK
      }

      // Also skip very old messages as a fallback (e.g., if watermark is not set yet)
      if (messageCreateTime) {
        const messageAge = Date.now() - messageCreateTime;
        if (messageAge > MAX_MESSAGE_AGE_MS) {
          log(`Gateway: skipping stale message (age=${Math.round(messageAge / 1000)}s, max=${MAX_MESSAGE_AGE_MS / 1000}s)`);
          return; // Return quickly to ACK
        }
      }

      // Update watermark BEFORE async processing to prevent duplicate handling
      if (chatId && messageCreateTime) {
        updateWatermark(chatId, messageCreateTime);
      }

      // Enqueue message for serial processing within this chat
      // This ensures we return within 3 seconds to ACK the event,
      // while messages in the same chat are processed one at a time (no race conditions)
      const queueChatId = chatId ?? "unknown";
      enqueueMessage(
        queueChatId,
        event,
        async () => {
          await handleMessage({
            cfg,
            event,
            botOpenId: state.botOpenId,
            botName: state.botName,
            runtime,
            chatHistories: state.chatHistories,
            batchProcessor: state.batchProcessor ?? undefined,
          });
        },
        { log, error }
      );
    },

    "im.chat.member.bot.added_v1": async (data: unknown) => {
      const event = data as BotAddedEvent;
      log(`Gateway: bot added to chat ${event.chat_id}`);
    },

    "im.chat.member.bot.deleted_v1": async (data: unknown) => {
      const event = data as BotRemovedEvent;
      log(`Gateway: bot removed from chat ${event.chat_id}`);
      if (state.chatHistories.has(event.chat_id)) {
        state.chatHistories.delete(event.chat_id);
      }
    },
  });

  // Handle abort signal
  const onAbort = () => {
    log("Gateway: abort signal received, stopping...");
    state.shouldStop = true;
    if (state.batchProcessor) {
      state.batchProcessor.dispose();
      state.batchProcessor = null;
    }
    if (state.wsClient) {
      state.wsClient = null;
    }
  };

  if (abortSignal?.aborted) {
    onAbort();
    throw new Error("Gateway aborted before start");
  }

  abortSignal?.addEventListener("abort", onAbort, { once: true });

  // Start WebSocket with reconnection loop
  return startWithReconnect(feishuCfg, eventDispatcher, { log, error });
}

/**
 * Start WebSocket connection with automatic reconnection on failure.
 */
async function startWithReconnect(
  feishuCfg: Config,
  eventDispatcher: Lark.EventDispatcher,
  logger: { log: (msg: string) => void; error: (msg: string) => void }
): Promise<void> {
  const { log, error } = logger;

  while (!state.shouldStop && state.reconnectAttempts < RECONNECT_MAX_ATTEMPTS) {
    try {
      log(
        `Gateway: starting WebSocket connection... (attempt ${state.reconnectAttempts + 1}/${RECONNECT_MAX_ATTEMPTS})`
      );

      // Create fresh WebSocket client for each attempt
      const wsClient = createWsClient(feishuCfg);
      state.wsClient = wsClient;

      // Start the WebSocket client
      await wsClient.start({ eventDispatcher });

      // Connection successful - reset attempts
      state.reconnectAttempts = 0;
      state.isReconnecting = false;
      log("Gateway: WebSocket client started successfully");

      // The SDK's start() resolves immediately after connection.
      // We need to keep the gateway running, so we wait indefinitely
      // until shouldStop is set or the connection drops.
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (state.shouldStop) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 1000);
      });

      // If we reach here and shouldStop is true, exit cleanly
      if (state.shouldStop) {
        log("Gateway: stopping due to abort signal");
        return;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      state.reconnectAttempts++;
      state.isReconnecting = true;

      if (state.shouldStop) {
        log("Gateway: stopping due to abort signal during reconnection");
        return;
      }

      if (state.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
        error(
          `Gateway: max reconnection attempts (${RECONNECT_MAX_ATTEMPTS}) reached. Last error: ${errorMessage}`
        );
        throw new Error(`WebSocket connection failed after ${RECONNECT_MAX_ATTEMPTS} attempts`);
      }

      const delay = calculateBackoffDelay(state.reconnectAttempts);
      error(
        `Gateway: WebSocket connection failed: ${errorMessage}. Reconnecting in ${delay}ms (attempt ${state.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})`
      );

      await sleep(delay);
    }
  }

  if (state.shouldStop) {
    log("Gateway: stopped by user request");
  }
}

export async function stopGateway(): Promise<void> {
  state.shouldStop = true;
  if (state.batchProcessor) {
    state.batchProcessor.dispose();
    state.batchProcessor = null;
  }
  if (state.wsClient) {
    state.wsClient = null;
  }
  state.botOpenId = undefined;
  state.botName = undefined;
  state.chatHistories.clear();
  state.isReconnecting = false;
  state.reconnectAttempts = 0;
  // Stop dedup cleanup timer and clear queues
  stopDedupCleanup();
  clearAllQueues();
}
