import { describe, expect, it } from "vitest";
import { MemoryContextProjector } from "./memory-projector.js";
import { createToolResultBudgetState } from "../memory/short-term/index.js";
import type { AgentMessage, ContextRequest } from "../protocol/index.js";

const capabilities = {
  contextHook: true, replaceContext: true, compactionHook: true, replaceCompaction: true,
  sessionLifecycle: true, threadLifecycle: true, toolLifecycle: true, persistentCustomEntries: true,
};
const request = (messages: readonly AgentMessage[], mode: "enhance" | "managed-context"): ContextRequest => ({
  requestId: "r", sessionId: "s", threadId: "t", mode, canonicalMessages: messages,
  frameworkMessages: messages, capabilities, contextWindow: 32_000, metadata: { projectId: "p" },
});

describe("MemoryContextProjector", () => {
  it("enhance mode injects memory without destructively rewriting framework context", async () => {
    const messages: AgentMessage[] = [{ id: "u", role: "user", content: [{ type: "text", text: "context policy" }] }];
    const projector = new MemoryContextProjector({ recall: async () => [{ id: "m", scope: "project", content: "Keep canonical" }] });
    const result = await projector.project({ request: request(messages, "enhance"), mode: "enhance", messages });
    expect(result[0]).toBe(messages[0]);
    expect(result.at(-1)?.metadata?.dynamicMemory).toBe(true);
  });

  it("managed mode offloads oversized tool results but keeps the canonical input untouched", async () => {
    const messages: AgentMessage[] = [
      { id: "a", role: "assistant", content: [{ type: "tool-call", id: "c", name: "read", arguments: {} }] },
      { id: "t", role: "tool", content: [{ type: "tool-result", toolCallId: "c", output: "x".repeat(2_000) }] },
      { id: "u", role: "user", content: [{ type: "text", text: "continue" }] },
    ];
    const projector = new MemoryContextProjector({ toolResultBudget: {
      state: createToolResultBudgetState(),
      options: { maxTokensPerMessage: 20, offloader: { put: async () => ({ uri: "blob:sha256:x" }) } },
    } });
    const result = await projector.project({ request: request(messages, "managed-context"), mode: "managed-context", messages });
    expect(JSON.stringify(result)).toContain("Tool result offloaded");
    expect(JSON.stringify(messages)).toContain("x".repeat(100));
  });
});
