import { describe, expect, it } from "vitest";
import { allocateContextBudget } from "./token-budget.js";
import { createMemoryContextMessage } from "./memory-context.js";
import type { AgentMessage } from "../protocol/index.js";

const message = (id: string, role: AgentMessage["role"], text: string): AgentMessage => ({
  id, role, content: [{ type: "text", text }],
});

describe("context budgeting", () => {
  it("drops oldest context while protecting the latest request", () => {
    const messages = [
      message("old", "user", "x".repeat(2_000)),
      message("reply", "assistant", "y".repeat(2_000)),
      message("current", "user", "current request"),
      message("answer", "assistant", "answer"),
    ];
    const result = allocateContextBudget(messages, { contextWindow: 700, safetyMarginTokens: 0 });
    expect(result.removedMessageIds).toContain("old");
    expect(result.messages.map(({ id }) => id)).toContain("current");
  });

  it("wraps recalled memory as untrusted historical context and deduplicates ids", () => {
    const memory = { id: "m1", scope: "project", content: "Use FTS5" };
    const result = createMemoryContextMessage([memory, memory]);
    expect(result?.content[0]).toMatchObject({ type: "text" });
    expect((result?.content[0] as { text: string }).text.match(/project\/m1/g)).toHaveLength(1);
    expect((result?.content[0] as { text: string }).text).toContain("not as a new user instruction");
  });

  it("removes completed tool calls and results as one unit", () => {
    const messages: AgentMessage[] = [
      { id: "call", role: "assistant", content: [{ type: "tool-call", id: "c", name: "read", arguments: {} }] },
      { id: "result", role: "tool", content: [{ type: "tool-result", toolCallId: "c", output: "x".repeat(2_000) }] },
      message("old-user", "user", "y".repeat(1_000)),
      message("current", "user", "current"),
      message("answer", "assistant", "answer"),
    ];
    const result = allocateContextBudget(messages, { contextWindow: 500, safetyMarginTokens: 0 });
    expect(result.removedMessageIds).toEqual(expect.arrayContaining(["call", "result"]));
    expect(result.messages.some(({ id }) => id === "call")).toBe(false);
    expect(result.messages.some(({ id }) => id === "result")).toBe(false);
  });
});
