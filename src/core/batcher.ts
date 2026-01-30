/**
 * 消息批处理器 - 实现防抖和空闲检测的消息缓冲
 */

import type { ParsedMessage } from "../types/index.js";

// ============================================================================
// Constants
// ============================================================================

/** 启动等待期（毫秒）- 前 10s 内不自动 flush */
const STARTUP_WAIT_MS = 10_000;

/** 空闲阈值（毫秒）- 最后一条消息后 1s 无新消息则触发 */
const IDLE_THRESHOLD_MS = 1_000;

/** 防抖延迟（毫秒）- trigger 调用后 500ms 执行 flush */
const DEBOUNCE_MS = 500;

// ============================================================================
// Types
// ============================================================================

/** 批处理刷新事件 */
export interface BatchFlushEvent {
  /** 聊天 ID */
  chatId: string;
  /** 缓冲的消息列表 */
  messages: ParsedMessage[];
  /** 触发来源标识 */
  triggeredBy: string;
  /** 触发时间戳 */
  triggeredAt: number;
}

/** 单个聊天的状态 */
interface ChatState {
  /** 消息缓冲区 */
  buffer: ParsedMessage[];
  /** 是否已标记需要触发 */
  hasTrigger: boolean;
  /** 触发器 ID */
  triggerId?: string;
  /** 防抖计时器 */
  debounceTimer?: ReturnType<typeof setTimeout>;
  /** 空闲检测计时器 */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** 最后一条消息时间戳 */
  lastMessageAt: number;
}

/** 批处理器接口 */
export interface ChatBatcher {
  /** 添加消息到缓冲区 */
  push(message: ParsedMessage): void;
  /** 标记聊天需要触发 flush */
  trigger(chatId: string, triggerId: string): void;
  /** 清空指定聊天的缓冲区 */
  clear(chatId: string): void;
  /** 释放所有资源 */
  dispose(): void;
  /** 注册 flush 回调函数 */
  onFlush(callback: (event: BatchFlushEvent) => Promise<void>): void;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * 创建消息批处理器
 * @param startedAt 启动时间戳（用于计算启动等待期）
 * @returns 批处理器实例
 */
export function createChatBatcher(startedAt: number): ChatBatcher {
  const chatStates = new Map<string, ChatState>();
  let flushCallback: ((event: BatchFlushEvent) => Promise<void>) | undefined;

  /**
   * 执行 flush 操作
   */
  async function flush(chatId: string, triggeredBy: string): Promise<void> {
    const state = chatStates.get(chatId);
    if (!state || state.buffer.length === 0) {
      return;
    }

    const event: BatchFlushEvent = {
      chatId,
      messages: [...state.buffer],
      triggeredBy,
      triggeredAt: Date.now(),
    };

    // 清空状态
    state.buffer = [];
    state.hasTrigger = false;
    state.triggerId = undefined;
    clearTimers(state);

    // 调用回调
    await flushCallback?.(event);
  }

  /**
   * 清除状态中的所有计时器
   */
  function clearTimers(state: ChatState): void {
    if (state.debounceTimer !== undefined) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = undefined;
    }
    if (state.idleTimer !== undefined) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
  }

  /**
   * 检查是否在启动等待期内
   */
  function isInStartupPeriod(): boolean {
    return Date.now() - startedAt < STARTUP_WAIT_MS;
  }

  /**
   * 启动空闲检测计时器
   */
  function startIdleTimer(chatId: string, state: ChatState): void {
    // 清除旧的 idle timer
    if (state.idleTimer !== undefined) {
      clearTimeout(state.idleTimer);
    }

    state.idleTimer = setTimeout(() => {
      // 只有在有 trigger 标记时才 flush
      if (state.hasTrigger && !isInStartupPeriod()) {
        void flush(chatId, state.triggerId ?? "idle-timeout");
      }
    }, IDLE_THRESHOLD_MS);
  }

  /**
   * 启动防抖计时器
   */
  function startDebounceTimer(chatId: string, state: ChatState, triggerId: string): void {
    // 清除旧的 debounce timer
    if (state.debounceTimer !== undefined) {
      clearTimeout(state.debounceTimer);
    }

    state.debounceTimer = setTimeout(() => {
      void flush(chatId, triggerId);
    }, DEBOUNCE_MS);
  }

  /**
   * 获取或创建聊天状态
   */
  function getOrCreateState(chatId: string): ChatState {
    let state = chatStates.get(chatId);
    if (!state) {
      state = {
        buffer: [],
        hasTrigger: false,
        lastMessageAt: 0,
      };
      chatStates.set(chatId, state);
    }
    return state;
  }

  // ============================================================================
  // Public API
  // ============================================================================

  return {
    /**
     * 添加消息到缓冲区
     */
    push(message: ParsedMessage): void {
      const state = getOrCreateState(message.chatId);
      state.buffer.push(message);
      state.lastMessageAt = Date.now();

      // 重置空闲计时器
      startIdleTimer(message.chatId, state);
    },

    /**
     * 标记聊天需要触发 flush
     */
    trigger(chatId: string, triggerId: string): void {
      const state = getOrCreateState(chatId);
      state.hasTrigger = true;
      state.triggerId = triggerId;

      // 启动防抖计时器（会自动取消之前的计时器）
      startDebounceTimer(chatId, state, triggerId);
    },

    /**
     * 清空指定聊天的缓冲区
     */
    clear(chatId: string): void {
      const state = chatStates.get(chatId);
      if (state) {
        clearTimers(state);
        chatStates.delete(chatId);
      }
    },

    /**
     * 释放所有资源
     */
    dispose(): void {
      for (const state of chatStates.values()) {
        clearTimers(state);
      }
      chatStates.clear();
    },

    /**
     * 注册 flush 回调函数
     */
    onFlush(callback: (event: BatchFlushEvent) => Promise<void>): void {
      flushCallback = callback;
    },
  };
}
