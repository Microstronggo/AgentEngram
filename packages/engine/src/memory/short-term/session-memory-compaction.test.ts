import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../protocol/message.js";
import { updateSessionMemory } from "./session-memory.js";
import {
  calculateSessionMemoryKeepStart,
  compactFromSessionMemory,
} from "./session-memory-compaction.js";

const estimate = (value: unknown): number => typeof value === "string" ? value.length : JSON.stringify(value).length;
const text = (id: string, value = id, metadata?: Record<string, unknown>): AgentMessage => ({
  id,
  role: "user",
  content: [{ type: "text", text: value }],
  ...(metadata ? { metadata } : {}),
});
const call = (id: string, toolId: string, metadata?: Record<string, unknown>): AgentMessage => ({
  id,
  role: "assistant",
  content: [{ type: "tool-call", id: toolId, name: "Read", arguments: {} }],
  ...(metadata ? { metadata } : {}),
});
const result = (id: string, toolId: string): AgentMessage => ({
  id,
  role: "tool",
  content: [{ type: "tool-result", toolCallId: toolId, output: "tool output" }],
});

describe("SessionMemoryCompaction", () => {
  it("uses summarizedThroughEventId as the compaction boundary and preserves a useful recent suffix", () => {
    const messages = [
      text("old", "old"),
      text("summarized", "summarized"),
      text("recent-1", "a".repeat(4)),
      text("recent-2", "b".repeat(4)),
      text("recent-3", "c".repeat(4)),
    ];
    const memory = updateSessionMemory(undefined, {
      summarizedThroughEventId: "summarized",
      goals: ["ship memory"],
      decisions: ["use managed-context"],
    });

    const compacted = compactFromSessionMemory(messages, {
      sessionMemory: memory,
      estimator: estimate,
      config: { minTokens: 8, minTextBlockMessages: 2, maxTokens: 100 },
    });

    expect(compacted?.messages.map(({ id }) => id)).toEqual([
      expect.stringMatching(/^compact-summary:/),
      "recent-1",
      "recent-2",
      "recent-3",
    ]);
    expect(JSON.stringify(compacted?.messages[0])).toContain("ship memory");
    expect(compacted?.boundary.summaryModel).toBe("session-memory");
    expect(compacted?.boundary.manifest.compactedEventIds).toEqual(["old", "summarized"]);
  });

  it("does not expand the kept suffix across an existing compact boundary", () => {
    const messages = [
      text("very-old", "x".repeat(100)),
      text("boundary", "summary", { projection: "compact-summary" }),
      text("summarized", "done"),
      text("tail", "tail"),
    ];
    const memory = updateSessionMemory(undefined, { summarizedThroughEventId: "summarized", goals: ["g"] });
    const start = calculateSessionMemoryKeepStart(messages, memory, {
      minTokens: 100,
      minTextBlockMessages: 2,
      maxTokens: 1_000,
    }, estimate);
    expect(messages[start]?.id).toBe("summarized");
  });

  it("extends the kept suffix to preserve tool pairs and provider message-id siblings", () => {
    const messages = [
      text("summarized", "done"),
      call("thinking", "old-tool", { providerMessageId: "assistant-1" }),
      call("call", "call-1", { providerMessageId: "assistant-1" }),
      result("result", "call-1"),
      text("tail", "tail"),
    ];
    const memory = updateSessionMemory(undefined, { summarizedThroughEventId: "summarized", goals: ["g"] });
    const start = calculateSessionMemoryKeepStart(messages, memory, {
      minTokens: 1,
      minTextBlockMessages: 1,
      maxTokens: 1_000,
    }, estimate);

    expect(messages[start]?.id).toBe("thinking");
  });

  it("falls back when session memory compaction still exceeds the auto-compact threshold", () => {
    const memory = updateSessionMemory(undefined, { summarizedThroughEventId: "old", goals: ["g".repeat(100)] });
    expect(compactFromSessionMemory([text("old"), text("tail", "tail")], {
      sessionMemory: memory,
      estimator: estimate,
      autoCompactThresholdTokens: 1,
    })).toBeUndefined();
  });
});
