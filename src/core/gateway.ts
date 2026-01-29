/**
 * WebSocket gateway for real-time Feishu events.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "clawdbot/plugin-sdk";
import type { Config } from "../config/schema.js";
import type { MessageReceivedEvent, BotAddedEvent, BotRemovedEvent } from "../types/index.js";
import { createWsClient, probeConnection } from "../api/client.js";
import { handleMessage } from "./handler.js";

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
}

// ============================================================================
// Gateway State
// ============================================================================

const state: GatewayState = {
  botName: undefined,
  botOpenId: undefined,
  wsClient: null,
  chatHistories: new Map(),
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

  // Probe to get bot info - MUST succeed for mention detection
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

  log("Gateway: starting WebSocket connection...");

  const wsClient = createWsClient(feishuCfg);
  state.wsClient = wsClient;

  const eventDispatcher = new Lark.EventDispatcher({});

  eventDispatcher.register({
    "im.message.receive_v1": async (data: unknown) => {
      try {
        const event = data as MessageReceivedEvent;
        await handleMessage({
          cfg,
          event,
          botOpenId: state.botOpenId,
          botName: state.botName,
          runtime,
          chatHistories: state.chatHistories,
        });
      } catch (err) {
        error(`Gateway: error handling message: ${String(err)}`);
      }
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

  return new Promise<void>((_resolve, reject) => {
    const onAbort = () => {
      if (state.wsClient) {
        try {
          // WSClient doesn't have a close method, just clear reference
          state.wsClient = null;
        } catch {
          // Ignore close errors
        }
      }
      reject(new Error("Gateway aborted"));
    };

    if (abortSignal?.aborted) {
      onAbort();
      return;
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });

    wsClient.start({ eventDispatcher }).then(
      () => {
        log("Gateway: WebSocket client started");
      },
      (err: Error) => {
        error(`Gateway: WebSocket connection failed: ${err.message}`);
        reject(err);
      }
    );
  });
}

export async function stopGateway(): Promise<void> {
  if (state.wsClient) {
    state.wsClient = null;
  }
  state.botOpenId = undefined;
  state.botName = undefined;
  state.chatHistories.clear();
}
