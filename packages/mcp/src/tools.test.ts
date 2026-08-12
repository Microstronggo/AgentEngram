import { describe, expect, it, vi } from "vitest";
import { createMemoryToolHandlers, toolResult } from "./tools.js";

describe("MCP memory handlers", () => {
  it("delegates to the shared application service", async () => {
    const service = {
      remember: vi.fn(async (input) => ({ ...input, id: "memory-1" })),
      write: vi.fn(async (input) => ({ action: "created", record: input })),
      update: vi.fn(async (input) => ({ action: "updated", record: input })),
      correct: vi.fn(async (input) => ({ action: "superseded", record: input })),
      search: vi.fn(async (input) => [input]),
      read: vi.fn(async (_scope, id) => ({ id })),
      forget: vi.fn(async () => true),
      feedback: vi.fn(async (input) => ({ ...input, id: "feedback-1" })),
      inspectContext: vi.fn(async (sessionId) => ({ sessionId })),
    };
    const handlers = createMemoryToolHandlers(service as never);
    await expect(handlers.remember({
      name: "Policy", description: "Context policy", content: "Keep transcript", type: "project", scope: "project", projectId: "p",
    })).resolves.toMatchObject({ id: "memory-1" });
    await handlers.write({ operation: "upsert", name: "n", description: "d", content: "c", type: "project", scope: "project" });
    await handlers.update({ operation: "update", targetMemoryId: "m1", name: "n", description: "d", content: "c", type: "project", scope: "project" });
    await handlers.correct({ operation: "correct", targetMemoryId: "m1", name: "n", description: "d", content: "c", type: "feedback", scope: "project" });
    await handlers.search({ text: "policy", projectId: "p" });
    await handlers.read({ scope: "project", id: "m1", projectId: "p" });
    await handlers.forget({ scope: "project", id: "m1", projectId: "p" });
    await handlers.feedback({ name: "f", description: "d", content: "c", scope: "project" });
    await handlers.inspectContext({ sessionId: "s1" });
    expect(Object.values(service).every((method) => method.mock.calls.length === 1)).toBe(true);
    expect(toolResult({ ok: true })).toEqual({ content: [{ type: "text", text: "{\n  \"ok\": true\n}" }] });
  });
});
