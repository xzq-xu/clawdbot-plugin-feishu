/**
 * Unit tests for plugin/tools.ts
 */

import { describe, it, expect } from "vitest";
import {
  createListMessagesTool,
  createSendCardTool,
} from "../../../dist/plugin/tools.js";

// ============================================================================
// createListMessagesTool Tests
// ============================================================================

describe("createListMessagesTool", () => {
  it("creates a tool with correct metadata", () => {
    const tool = createListMessagesTool({ getConfig: () => undefined });

    expect(tool.name).toBe("feishu_list_messages");
    expect(tool.label).toBe("Feishu Messages");
    expect(tool.description).toContain("Retrieve message history");
    expect(tool.parameters).toBeDefined();
  });

  it("returns error when config is not available", async () => {
    const tool = createListMessagesTool({ getConfig: () => undefined });
    const result = await tool.execute("test-id", { chatId: "oc_123" });

    expect(result.content[0].text).toContain("Feishu not configured");
  });

  it("returns error when chatId is missing", async () => {
    const mockConfig = { appId: "test", appSecret: "secret" };
    const tool = createListMessagesTool({
      getConfig: () => mockConfig as ReturnType<typeof createListMessagesTool extends (opts: { getConfig: () => infer R }) => unknown ? () => R : never>,
    });
    const result = await tool.execute("test-id", {});

    expect(result.content[0].text).toContain("chatId is required");
  });
});

// ============================================================================
// createSendCardTool Tests
// ============================================================================

describe("createSendCardTool", () => {
  it("creates a tool with correct metadata", () => {
    const tool = createSendCardTool({ getConfig: () => undefined });

    expect(tool.name).toBe("feishu_card");
    expect(tool.label).toBe("Feishu Card");
    expect(tool.description).toContain("interactive card");
    expect(tool.description).toContain("action");
    expect(tool.description).not.toContain("coming soon");
    expect(tool.parameters).toBeDefined();
  });

  it("returns error when config is not available", async () => {
    const tool = createSendCardTool({ getConfig: () => undefined });
    const result = await tool.execute("test-id", {
      elements: [{ tag: "markdown", content: "test" }],
    });

    expect(result.content[0].text).toContain("Feishu not configured");
  });

  it("returns error when target is not specified and no context", async () => {
    const mockConfig = { appId: "test", appSecret: "secret" };
    const tool = createSendCardTool({
      getConfig: () => mockConfig as ReturnType<typeof createSendCardTool extends (opts: { getConfig: () => infer R }) => unknown ? () => R : never>,
    });
    const result = await tool.execute("test-id", {
      elements: [{ tag: "markdown", content: "test" }],
    });

    expect(result.content[0].text).toContain("Target not specified");
  });

  it("returns error when elements array is empty", async () => {
    const mockConfig = { appId: "test", appSecret: "secret" };
    const tool = createSendCardTool({
      getConfig: () => mockConfig as ReturnType<typeof createSendCardTool extends (opts: { getConfig: () => infer R }) => unknown ? () => R : never>,
    });
    const result = await tool.execute("test-id", {
      to: "oc_123",
      elements: [],
    });

    expect(result.content[0].text).toContain("at least one element");
  });

  it("uses getCurrentTarget when to is not provided", async () => {
    const mockConfig = { appId: "test", appSecret: "secret" };
    const tool = createSendCardTool({
      getConfig: () => mockConfig as ReturnType<typeof createSendCardTool extends (opts: { getConfig: () => infer R }) => unknown ? () => R : never>,
      getCurrentTarget: () => "oc_fallback_chat",
    });

    // This will fail at API call level, but we can verify the target resolution works
    const result = await tool.execute("test-id", {
      elements: [{ tag: "markdown", content: "test" }],
    });

    // Should not complain about target (will fail at API level instead)
    expect(result.content[0].text).not.toContain("Target not specified");
  });

  it("description includes button/action documentation", () => {
    const tool = createSendCardTool({ getConfig: () => undefined });

    expect(tool.description).toContain("action");
    expect(tool.description).toContain("button");
    expect(tool.description).toContain("primary");
    expect(tool.description).toContain("url");
  });
});
