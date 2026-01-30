/**
 * Unit tests for core/batch-processor.ts
 * 
 * Timing constants:
 * - STARTUP_WINDOW_MS = 10_000
 * - REALTIME_DEBOUNCE_MS = 2_000 (wait for user to finish typing)
 * - MAX_BATCH_WAIT_MS = 10_000 (max time after first trigger)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BatchProcessor } from "../../../dist/core/batch-processor.js";
import type { FlushParams } from "../../../dist/core/batch-processor.js";
import type { ParsedMessage } from "../../../dist/types/index.js";
import type { MessageReceivedEvent } from "../../../dist/types/index.js";

function createMockParsedMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    chatId: "oc_test_chat",
    messageId: `msg_${Date.now()}_${Math.random()}`,
    senderId: "u_sender",
    senderOpenId: "ou_sender",
    chatType: "group",
    mentionedBot: false,
    content: "test message",
    contentType: "text",
    ...overrides,
  };
}

function createMockEvent(chatId = "oc_test_chat"): MessageReceivedEvent {
  return {
    sender: {
      sender_id: { open_id: "ou_sender", user_id: "u_sender" },
      sender_type: "user",
    },
    message: {
      message_id: `msg_${Date.now()}`,
      chat_id: chatId,
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "test" }),
    },
  };
}

describe("BatchProcessor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("startup mode", () => {
    it("buffers messages without trigger in startup window", async () => {
      const onFlush = vi.fn();
      const processor = new BatchProcessor({
        cfg: { channels: { feishu: {} } } as never,
        chatHistories: new Map(),
        onFlush,
      });

      const parsed = createMockParsedMessage({ mentionedBot: false });
      const event = createMockEvent();

      processor.processMessage(parsed, event);

      await vi.advanceTimersByTimeAsync(11_000);

      expect(onFlush).not.toHaveBeenCalled();

      processor.dispose();
    });

    it("flushes when triggered within startup window", async () => {
      const onFlush = vi.fn();
      const processor = new BatchProcessor({
        cfg: { channels: { feishu: {} } } as never,
        chatHistories: new Map(),
        onFlush,
      });

      const parsed1 = createMockParsedMessage({ mentionedBot: false, content: "msg1" });
      const parsed2 = createMockParsedMessage({ mentionedBot: true, content: "msg2 @bot" });
      const event = createMockEvent();

      processor.processMessage(parsed1, event);
      processor.processMessage(parsed2, event);

      await vi.advanceTimersByTimeAsync(11_000);

      expect(onFlush).toHaveBeenCalledTimes(1);
      const flushParams: FlushParams = onFlush.mock.calls[0][0];
      expect(flushParams.messages).toHaveLength(2);
      expect(flushParams.triggerMessage.parsed.content).toBe("msg2 @bot");

      processor.dispose();
    });

    it("collects all messages before flush", async () => {
      const onFlush = vi.fn();
      const processor = new BatchProcessor({
        cfg: { channels: { feishu: {} } } as never,
        chatHistories: new Map(),
        onFlush,
      });

      const event = createMockEvent();

      for (let i = 0; i < 5; i++) {
        const parsed = createMockParsedMessage({
          mentionedBot: i === 4,
          content: `message ${i}`,
        });
        processor.processMessage(parsed, event);
        await vi.advanceTimersByTimeAsync(100);
      }

      await vi.advanceTimersByTimeAsync(11_000);

      expect(onFlush).toHaveBeenCalledTimes(1);
      const flushParams: FlushParams = onFlush.mock.calls[0][0];
      expect(flushParams.messages).toHaveLength(5);

      processor.dispose();
    });
  });

  describe("realtime mode", () => {
    it("debounces multiple triggers", async () => {
      const onFlush = vi.fn();
      const processor = new BatchProcessor({
        cfg: { channels: { feishu: {} } } as never,
        chatHistories: new Map(),
        onFlush,
      });

      // Exit startup mode
      await vi.advanceTimersByTimeAsync(11_000);

      const event = createMockEvent();

      // Send 3 triggers with short intervals
      processor.processMessage(
        createMockParsedMessage({ mentionedBot: true, content: "trigger1" }),
        event
      );
      await vi.advanceTimersByTimeAsync(500);

      processor.processMessage(
        createMockParsedMessage({ mentionedBot: true, content: "trigger2" }),
        event
      );
      await vi.advanceTimersByTimeAsync(500);

      processor.processMessage(
        createMockParsedMessage({ mentionedBot: true, content: "trigger3" }),
        event
      );

      // Wait for debounce (2000ms from last message)
      await vi.advanceTimersByTimeAsync(2_500);

      // Should flush once with all 3 messages
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush.mock.calls[0][0].messages).toHaveLength(3);

      processor.dispose();
    });

    it("resets debounce timer on each new message", async () => {
      const onFlush = vi.fn();
      const processor = new BatchProcessor({
        cfg: { channels: { feishu: {} } } as never,
        chatHistories: new Map(),
        onFlush,
      });

      // Exit startup mode
      await vi.advanceTimersByTimeAsync(11_000);

      const event = createMockEvent();

      // First trigger
      processor.processMessage(
        createMockParsedMessage({ mentionedBot: true, content: "trigger1" }),
        event
      );

      // Wait 1.5 seconds (less than 2s debounce)
      await vi.advanceTimersByTimeAsync(1_500);

      // Should not have flushed yet
      expect(onFlush).not.toHaveBeenCalled();

      // Send another message - this resets the debounce
      processor.processMessage(
        createMockParsedMessage({ mentionedBot: false, content: "more text" }),
        event
      );

      // Wait another 1.5 seconds
      await vi.advanceTimersByTimeAsync(1_500);

      // Still should not flush (only 1.5s since last message)
      expect(onFlush).not.toHaveBeenCalled();

      // Wait the remaining time
      await vi.advanceTimersByTimeAsync(1_000);

      // Now should have flushed
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush.mock.calls[0][0].messages).toHaveLength(2);

      processor.dispose();
    });
  });

  describe("per-chat isolation", () => {
    it("maintains separate state for different chats", async () => {
      const onFlush = vi.fn();
      const processor = new BatchProcessor({
        cfg: { channels: { feishu: {} } } as never,
        chatHistories: new Map(),
        onFlush,
      });

      // Exit startup mode
      await vi.advanceTimersByTimeAsync(11_000);

      const event1 = createMockEvent("oc_chat_1");
      const event2 = createMockEvent("oc_chat_2");

      // Chat 1 has trigger, chat 2 doesn't
      processor.processMessage(
        createMockParsedMessage({ chatId: "oc_chat_1", mentionedBot: true }),
        event1
      );
      processor.processMessage(
        createMockParsedMessage({ chatId: "oc_chat_2", mentionedBot: false }),
        event2
      );

      // Wait for debounce
      await vi.advanceTimersByTimeAsync(2_500);

      // Only chat 1 should flush
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush.mock.calls[0][0].chatId).toBe("oc_chat_1");

      processor.dispose();
    });

    it("flushes each chat independently", async () => {
      const onFlush = vi.fn();
      const processor = new BatchProcessor({
        cfg: { channels: { feishu: {} } } as never,
        chatHistories: new Map(),
        onFlush,
      });

      // Exit startup mode
      await vi.advanceTimersByTimeAsync(11_000);

      const event1 = createMockEvent("oc_chat_1");
      const event2 = createMockEvent("oc_chat_2");

      // Both chats have triggers
      processor.processMessage(
        createMockParsedMessage({ chatId: "oc_chat_1", mentionedBot: true }),
        event1
      );
      processor.processMessage(
        createMockParsedMessage({ chatId: "oc_chat_2", mentionedBot: true }),
        event2
      );

      // Wait for debounce
      await vi.advanceTimersByTimeAsync(2_500);

      expect(onFlush).toHaveBeenCalledTimes(2);
      const chatIds = onFlush.mock.calls.map((call) => call[0].chatId);
      expect(chatIds).toContain("oc_chat_1");
      expect(chatIds).toContain("oc_chat_2");

      processor.dispose();
    });
  });

  describe("max wait timer", () => {
    it("forces flush after max wait time even if messages keep coming", async () => {
      const onFlush = vi.fn();
      const processor = new BatchProcessor({
        cfg: { channels: { feishu: {} } } as never,
        chatHistories: new Map(),
        onFlush,
      });

      // Exit startup mode
      await vi.advanceTimersByTimeAsync(11_000);

      const event = createMockEvent();

      // First trigger
      processor.processMessage(
        createMockParsedMessage({ mentionedBot: true, content: "trigger1" }),
        event
      );

      // Keep sending messages every 1.5 seconds (before debounce fires)
      // This would normally prevent flush forever
      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(1_500);
        processor.processMessage(
          createMockParsedMessage({ mentionedBot: false, content: `msg ${i}` }),
          event
        );
      }

      // After 12 seconds total (> 10s max wait), should have flushed
      expect(onFlush).toHaveBeenCalledTimes(1);

      processor.dispose();
    });
  });

  describe("dispose", () => {
    it("clears all timers and state", async () => {
      const onFlush = vi.fn();
      const processor = new BatchProcessor({
        cfg: { channels: { feishu: {} } } as never,
        chatHistories: new Map(),
        onFlush,
      });

      const event = createMockEvent();

      processor.processMessage(createMockParsedMessage({ mentionedBot: true }), event);

      processor.dispose();

      await vi.advanceTimersByTimeAsync(15_000);

      expect(onFlush).not.toHaveBeenCalled();
    });
  });
});
