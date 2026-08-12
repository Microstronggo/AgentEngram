import { describe, expect, it } from "vitest";
import { fallbackContextOwnership, resolveContextOwnership } from "./context-ownership.js";
import { ContextPipeline } from "./context-pipeline.js";
import { projector } from "./context-projector.js";

const capable = { replaceContext: true, replaceCompaction: true };

describe("context ownership", () => {
  it("keeps auto and enhance under host ownership", () => {
    expect(resolveContextOwnership({ requestedMode: "auto", capabilities: capable, managedRuntimeReady: true }))
      .toMatchObject({ effectiveMode: "enhance", contextOwner: "host", compactionOwner: "host" });
    expect(resolveContextOwnership({ requestedMode: "enhance", capabilities: capable, managedRuntimeReady: true }))
      .toMatchObject({ effectiveMode: "enhance", fallbackCount: 0 });
  });

  it("grants managed ownership only when replacement and Runtime dependencies are complete", () => {
    expect(resolveContextOwnership({
      requestedMode: "managed-context",
      capabilities: capable,
      managedRuntimeReady: true,
    })).toMatchObject({
      effectiveMode: "managed-context",
      contextOwner: "agentengram",
      compactionOwner: "agentengram",
    });

    expect(() => resolveContextOwnership({
      requestedMode: "managed-context",
      capabilities: { ...capable, replaceCompaction: false },
      managedRuntimeReady: true,
    })).toThrow("compaction replacement");
    expect(() => resolveContextOwnership({
      requestedMode: "managed-context",
      capabilities: capable,
      managedRuntimeReady: false,
    })).toThrow("dependencies");
  });

  it("records observable host fallback and honors strict ownership", () => {
    const ownership = resolveContextOwnership({
      requestedMode: "managed-context",
      capabilities: capable,
      managedRuntimeReady: true,
    });
    expect(fallbackContextOwnership(ownership, "compact-failed")).toMatchObject({
      requestedMode: "managed-context",
      effectiveMode: "enhance",
      fallbackReason: "compact-failed",
      fallbackCount: 1,
    });

    expect(() => fallbackContextOwnership({ ...ownership, failurePolicy: "strict" }, "context-invalid"))
      .toThrow("projection is invalid");
  });

  it("propagates negotiated ownership and records a managed projection fallback", async () => {
    const ownership = resolveContextOwnership({
      requestedMode: "managed-context",
      capabilities: capable,
      managedRuntimeReady: true,
    });
    const messages = [{ id: "user-1", role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];
    const view = await new ContextPipeline({
      mode: "managed-context",
      projectors: [projector(() => { throw new Error("projection failed"); })],
    }).build({
      requestId: "request-1",
      sessionId: "session-1",
      threadId: "thread-1",
      canonicalMessages: messages,
      frameworkMessages: messages,
      capabilities: {
        contextHook: true,
        replaceContext: true,
        compactionHook: true,
        replaceCompaction: true,
        sessionLifecycle: true,
        threadLifecycle: true,
        toolLifecycle: true,
        persistentCustomEntries: true,
      },
      ownership,
    });

    expect(view.diagnostics?.ownership).toMatchObject({
      requestedMode: "managed-context",
      effectiveMode: "enhance",
      fallbackReason: "projection-failed",
      fallbackCount: 1,
    });
  });

  it("distinguishes an unsafe projected message graph from a projector failure", async () => {
    const ownership = resolveContextOwnership({
      requestedMode: "managed-context",
      capabilities: capable,
      managedRuntimeReady: true,
    });
    const frameworkMessages = [{ id: "safe", role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];
    const view = await new ContextPipeline({
      mode: "managed-context",
      projectors: [projector(() => [{
        id: "orphan",
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "missing", output: "unsafe" }],
      }])],
    }).build({
      requestId: "request-invalid",
      sessionId: "session-1",
      threadId: "thread-1",
      canonicalMessages: frameworkMessages,
      frameworkMessages,
      capabilities: {
        contextHook: true,
        replaceContext: true,
        compactionHook: true,
        replaceCompaction: true,
        sessionLifecycle: true,
        threadLifecycle: true,
        toolLifecycle: true,
        persistentCustomEntries: true,
      },
      ownership,
    });

    expect(view.source).toBe("fail-open");
    expect(view.diagnostics?.ownership?.fallbackReason).toBe("context-invalid");
  });
});
