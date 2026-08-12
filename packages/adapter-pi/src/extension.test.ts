import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEngramRuntime, ContextPipeline } from "@agentengram/engine";
import defaultExtension, { createPiExtension } from "./extension.js";
import type { PiContext, PiEventName, PiExtensionApi, PiHandler, PiToolDefinition } from "./pi-types.js";
import {
  CHECKPOINT_CUSTOM_TYPE,
  type EngineFacade,
  type MemoryApplicationFacade,
  type PiAgentEngramCheckpointV1,
} from "./types.js";
import { createRuntimeEngineFacade } from "./runtime-engine-facade.js";

class FakePi implements PiExtensionApi {
  readonly handlers = new Map<PiEventName, PiHandler>();
  readonly entries: Array<{ customType: string; data: unknown }> = [];
  readonly tools = new Map<string, PiToolDefinition>();
  mode: string | undefined;

  on(event: PiEventName, handler: PiHandler): void {
    this.handlers.set(event, handler);
  }

  appendEntry<T>(customType: string, data?: T): void {
    this.entries.push({ customType, data });
  }

  registerTool(tool: PiToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerFlag(_name: string, options: { default: string }): void {
    this.mode = options.default;
  }

  getFlag(): string | undefined {
    return this.mode;
  }

  emit(event: PiEventName, payload: unknown, context = fakeContext()): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`No handler for ${event}`);
    return Promise.resolve(handler(payload, context));
  }
}

function fakeContext(): PiContext {
  return {
    cwd: "/repo",
    sessionManager: { getSessionFile: () => "/sessions/one.jsonl" },
    model: { id: "current-model", api: "openai-completions", provider: "test" },
    ui: { notify: vi.fn() },
  };
}

const managedLifecycle = {
  compact: () => undefined,
  createCheckpoint: () => undefined,
  restoreCheckpoint: () => ({ status: "unavailable" as const }),
  rebuildFromCanonical: () => ({ status: "rebuilt" as const }),
} satisfies Pick<EngineFacade, "compact" | "createCheckpoint" | "restoreCheckpoint" | "rebuildFromCanonical">;

function checkpoint(
  reason: PiAgentEngramCheckpointV1["reason"],
  overrides: Partial<PiAgentEngramCheckpointV1> = {},
): PiAgentEngramCheckpointV1 {
  return {
    schemaVersion: 1,
    projectId: "project",
    frameworkSessionId: "session",
    threadId: "thread",
    generation: 1,
    checkpointId: `checkpoint-${reason}`,
    projectionSeq: 4,
    projectionHeadHash: "head",
    checkpointHash: "checkpoint",
    reason,
    createdAt: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("Pi extension", () => {
  it("uses the project configuration as its installation default", async () => {
    const previous = process.cwd();
    const cwd = await mkdtemp(join(tmpdir(), "agentengram-pi-config-"));
    await mkdir(join(cwd, ".agentengram"), { recursive: true });
    await writeFile(join(cwd, ".agentengram", "config.json"), `${JSON.stringify({
      schemaVersion: 1,
      adapters: { pi: {
        mode: "managed-context",
        models: { compact: { strategy: "host-current" }, formation: { strategy: "disabled" } },
      } },
    })}\n`, "utf8");
    try {
      process.chdir(cwd);
      const pi = new FakePi();
      createPiExtension({
        engine: { managedContextReady: true, buildManagedContext: async () => ({ messages: [] }), ...managedLifecycle },
      })(pi);
      expect(pi.mode).toBe("managed-context");
    } finally {
      process.chdir(previous);
    }
  });

  it("default install entry is backed by AgentEngramRuntime", async () => {
    const pi = new FakePi();
    defaultExtension(pi);
    expect([...pi.tools.keys()]).toEqual([
      "memory_remember",
      "memory_upsert",
      "memory_update",
      "memory_correct",
      "memory_search",
      "memory_read",
      "memory_forget",
      "memory_feedback",
      "context_inspect",
    ]);
    const original = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 };

    const result = await pi.emit("context", { type: "context", messages: [original] });

    expect(result).toEqual({ messages: [original] });
    const inspect = await pi.tools.get("context_inspect")!.execute(
      "inspect-1",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    expect(inspect.details).toMatchObject({ ok: true, value: { available: true } });
  });

  it("maps safe Pi lifecycle events into the Engine runtime", async () => {
    const pi = new FakePi();
    const runtime = new AgentEngramRuntime();
    createPiExtension({ engine: createRuntimeEngineFacade(runtime) })(pi);

    await pi.emit("session_start", { type: "session_start", reason: "startup" });

    expect(runtime.events.session("/sessions/one.jsonl")?.snapshot()).toMatchObject({
      sessionId: "/sessions/one.jsonl",
      status: "active",
      eventCount: 1,
    });
  });

  it("maps repeated Pi deliveries to the same Engine event id", async () => {
    const pi = new FakePi();
    const runtime = new AgentEngramRuntime();
    createPiExtension({ engine: createRuntimeEngineFacade(runtime) })(pi);
    const payload = { type: "tool_result", toolCallId: "call-1", toolName: "read", isError: false };

    await pi.emit("tool_result", payload);
    await pi.emit("tool_result", payload);

    expect(runtime.events.session("/sessions/one.jsonl")?.snapshot().eventCount).toBe(1);
  });

  it("registers the complete lifecycle surface and defaults to conservative auto mode", () => {
    const pi = new FakePi();
    createPiExtension({ engine: {} })(pi);

    expect(pi.mode).toBe("auto");
    expect(pi.tools.size).toBe(0);
    expect([...pi.handlers.keys()]).toEqual(
      expect.arrayContaining([
        "session_start",
        "session_shutdown",
        "before_agent_start",
        "turn_end",
        "agent_end",
        "context",
        "tool_call",
        "tool_result",
        "session_before_compact",
        "session_compact",
        "session_before_tree",
        "session_tree",
        "model_select",
      ]),
    );
  });

  it("rejects explicit managed-context when the facade cannot own the lifecycle", () => {
    const pi = new FakePi();

    expect(() => createPiExtension({ mode: "managed-context", engine: {} })(pi))
      .toThrow(/managed-context requires/u);
    expect(pi.handlers.size).toBe(0);
  });

  it("registers native memory tools only when an application service is injected", () => {
    const pi = new FakePi();
    const memoryApplication = {
      remember: vi.fn(),
      search: vi.fn(),
      read: vi.fn(),
      forget: vi.fn(),
      feedback: vi.fn(),
      inspectContext: vi.fn(),
    } as unknown as MemoryApplicationFacade;
    createPiExtension({ engine: {}, memoryApplication })(pi);

    expect([...pi.tools.keys()]).toEqual([
      "memory_remember",
      "memory_upsert",
      "memory_update",
      "memory_correct",
      "memory_search",
      "memory_read",
      "memory_forget",
      "memory_feedback",
      "context_inspect",
    ]);
  });

  it("fails open and preserves Pi context when Engine projection throws", async () => {
    const pi = new FakePi();
    const engine: EngineFacade = {
      enhanceContext: () => {
        throw new Error("projection unavailable");
      },
    };
    createPiExtension({ engine })(pi);

    const result = await pi.emit("context", { type: "context", messages: [{ role: "user", content: "hi" }] });

    expect(result).toBeUndefined();
  });

  it("propagates managed projection ownership fallback diagnostics", async () => {
    const pi = new FakePi();
    let seenOwnership: import("@agentengram/engine").ContextOwnershipDiagnostic | undefined;
    createPiExtension({
      mode: "managed-context",
      engine: {
        managedContextReady: true,
        projectContextView: (request) => {
          seenOwnership = {
            ...request.ownership!,
            effectiveMode: "enhance",
            contextOwner: "host",
            compactionOwner: "host",
            fallbackReason: "projection-failed",
            fallbackCount: 1,
          };
          return {
            messages: request.messages,
            source: "fail-open",
            failure: { name: "Error", message: "projection failed" },
            ownership: seenOwnership,
          };
        },
      },
    })(pi);
    const original = [{ role: "user", content: "keep Pi context" }];

    const result = await pi.emit("context", { messages: original });

    expect(result).toEqual({ messages: original });
    expect(seenOwnership).toMatchObject({
      requestedMode: "managed-context",
      effectiveMode: "enhance",
      contextOwner: "host",
      compactionOwner: "host",
      fallbackReason: "projection-failed",
      fallbackCount: 1,
    });
  });

  it("does not swallow managed projection failures under strict ownership", async () => {
    const pi = new FakePi();
    createPiExtension({
      mode: "managed-context",
      managedFailurePolicy: "strict",
      engine: {
        managedContextReady: true,
        projectContextView: () => { throw new Error("strict projection failure"); },
      },
    })(pi);

    await expect(pi.emit("context", { messages: [] })).rejects.toThrow("strict projection failure");
  });

  it("rejects a serialized Engine fail-open view under strict ownership", async () => {
    const pi = new FakePi();
    createPiExtension({
      mode: "managed-context",
      managedFailurePolicy: "strict",
      engine: {
        managedContextReady: true,
        projectContextView: (request) => ({
          messages: request.messages,
          source: "fail-open",
          failure: { name: "Error", message: "serialized projection failure" },
          ownership: request.ownership,
        }),
      },
    })(pi);

    await expect(pi.emit("context", { messages: [] })).rejects.toThrow("serialized projection failure");
  });

  it("returns the complete Engine view in managed-context mode", async () => {
    const pi = new FakePi();
    const projected = [{ role: "system", content: "managed" }];
    createPiExtension({
      mode: "managed-context",
      engine: { ...managedLifecycle, buildManagedContext: () => projected },
    })(pi);

    const result = await pi.emit("context", { type: "context", messages: [] });

    expect(result).toEqual({ messages: projected });
  });

  it("uses Pi's canonical branch instead of an already-projected context in managed mode", async () => {
    const pi = new FakePi();
    const seen: unknown[][] = [];
    createPiExtension({
      mode: "managed-context",
      engine: {
        ...managedLifecycle,
        buildManagedContext: (request) => {
          seen.push(request.canonicalMessages ?? []);
          return request.canonicalMessages;
        },
      },
    })(pi);
    const context = fakeContext();
    context.sessionManager.getBranch = () => [
      { type: "message", message: { role: "user", content: "canonical" } },
    ];

    const result = await pi.emit("context", { messages: [{ role: "user", content: "projected" }] }, context);

    expect(seen).toEqual([[{ role: "user", content: "canonical" }]]);
    expect(result).toEqual({ messages: [{ role: "user", content: "canonical" }] });
  });

  it("uses enhance when auto is selected and the managed lifecycle is incomplete", async () => {
    const pi = new FakePi();
    const enhanceContext = vi.fn(() => [{ role: "system", content: "enhanced" }]);
    const buildManagedContext = vi.fn(() => [{ role: "system", content: "managed" }]);
    createPiExtension({ mode: "auto", engine: { enhanceContext, buildManagedContext } })(pi);

    const result = await pi.emit("context", { messages: [] });

    expect(result).toEqual({ messages: [{ role: "system", content: "enhanced" }] });
    expect(enhanceContext).toHaveBeenCalledOnce();
    expect(buildManagedContext).not.toHaveBeenCalled();
  });

  it("serializes Engine message changes instead of restoring stale Pi raw content", async () => {
    const pi = new FakePi();
    const runtime = new AgentEngramRuntime({
      context: new ContextPipeline({
        mode: "managed-context",
        projectors: [{
          project: ({ messages }) => messages.map((message) => ({
            ...message,
            content: [{ type: "text" as const, text: "projected" }],
          })),
        }],
      }),
    });
    const engine = createRuntimeEngineFacade(runtime);
    engine.managedContextReady = true;
    createPiExtension({ mode: "managed-context", engine })(pi);

    const result = await pi.emit("context", {
      type: "context",
      messages: [{ role: "user", content: [{ type: "text", text: "raw" }], timestamp: 1 }],
    });

    expect(result).toMatchObject({ messages: [{ role: "user", content: [{ type: "text", text: "projected" }] }] });
  });

  it("appends a validated pre-compact checkpoint pointer", async () => {
    const pi = new FakePi();
    const createCheckpoint = vi.fn((reason) => checkpoint(reason));
    createPiExtension({
      engine: { createCheckpoint },
    })(pi);
    const context = fakeContext();
    context.sessionManager.getSessionId = () => "session";
    context.sessionManager.getLeafId = () => "thread";
    context.sessionManager.getBranch = () => [{
      type: "message",
      id: "entry-1",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    }];

    await pi.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: {},
      branchEntries: [],
      signal: new AbortController().signal,
    }, context);

    expect(pi.entries).toEqual([
      { customType: CHECKPOINT_CUSTOM_TYPE, data: checkpoint("pre_compact") },
    ]);
    expect(createCheckpoint).toHaveBeenCalledWith("pre_compact", expect.objectContaining({
      sessionId: "session",
      threadId: "thread",
      canonicalMessages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }));
  });

  it("restores a tree target before checkpointing the recovered branch", async () => {
    const pi = new FakePi();
    const calls: string[] = [];
    createPiExtension({
      engine: {
        restoreCheckpoint: () => { calls.push("restore"); return { status: "restored", messages: [] }; },
        rebuildFromCanonical: () => { calls.push("rebuild"); return { status: "rebuilt", messages: [] }; },
        createCheckpoint: () => { calls.push("checkpoint"); return undefined; },
      },
    })(pi);
    const context = fakeContext();
    context.sessionManager.getSessionId = () => "session";
    context.sessionManager.getLeafId = () => "leaf-b";
    context.sessionManager.getBranch = () => [{
      type: "custom",
      customType: CHECKPOINT_CUSTOM_TYPE,
      data: checkpoint("tree_change", { frameworkSessionId: "session", threadId: "leaf-b" }),
    }];

    await pi.emit("session_tree", { newLeafId: "leaf-b", oldLeafId: "leaf-a" }, context);

    expect(calls).toEqual(["restore", "checkpoint"]);
  });

  it("returns Engine compaction only in managed-context mode", async () => {
    const pi = new FakePi();
    createPiExtension({
      mode: "managed-context",
      engine: {
        managedContextReady: true,
        buildManagedContext: () => undefined,
        createCheckpoint: () => undefined,
        compact: () => ({ summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 123 }),
      },
    })(pi);

    const result = await pi.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: {},
      branchEntries: [{ id: "entry-1", type: "message" }],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      compaction: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 123 },
    });
  });

  it("rejects an invalid managed compaction and lets Pi use its default", async () => {
    const pi = new FakePi();
    createPiExtension({
      mode: "managed-context",
      engine: {
        managedContextReady: true,
        buildManagedContext: () => undefined,
        createCheckpoint: () => undefined,
        compact: () => ({ summary: "summary", firstKeptEntryId: "not-on-branch", tokensBefore: 10 }),
      },
    })(pi);

    const result = await pi.emit("session_before_compact", {
      preparation: {},
      branchEntries: [{ id: "entry-1", type: "message" }],
      signal: new AbortController().signal,
    });

    expect(result).toBeUndefined();
  });

  it("continues managed compaction when the pre-compact checkpoint fails", async () => {
    const pi = new FakePi();
    createPiExtension({
      mode: "managed-context",
      engine: {
        managedContextReady: true,
        buildManagedContext: () => undefined,
        createCheckpoint: () => { throw new Error("disk unavailable"); },
        compact: () => ({ summary: "safe", firstKeptEntryId: "entry-1", tokensBefore: 10 }),
      },
    })(pi);

    const result = await pi.emit("session_before_compact", {
      preparation: {},
      branchEntries: [{ id: "entry-1", type: "message" }],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      compaction: { summary: "safe", firstKeptEntryId: "entry-1", tokensBefore: 10 },
    });
  });

  it("restores the newest valid checkpoint reachable from the active branch", async () => {
    const pi = new FakePi();
    const restoreCheckpoint = vi.fn(() => ({ status: "restored" as const, messages: [
      { role: "system", content: "restored segment" },
    ] }));
    const enhanceContext = vi.fn((request) => [
      ...request.messages,
      ...(request.recoveryMessages ?? []),
    ]);
    createPiExtension({ engine: { restoreCheckpoint, enhanceContext } })(pi);
    const context = fakeContext();
    const oldPointer = checkpoint("periodic", {
      frameworkSessionId: "/sessions/one.jsonl",
      checkpointId: "old",
    });
    const newestPointer = checkpoint("post_compact", {
      frameworkSessionId: "/sessions/one.jsonl",
      checkpointId: "newest",
    });
    context.sessionManager.getBranch = () => [
      { type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: oldPointer },
      { type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: { ...newestPointer, projectionSeq: -1 } },
      { type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: newestPointer },
    ];

    await pi.emit("session_start", { reason: "resume" }, context);
    const first = await pi.emit("context", { messages: [{ role: "user", content: "next" }] }, context);
    const second = await pi.emit("context", { messages: [{ role: "user", content: "next" }] }, context);

    expect(restoreCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ pointer: newestPointer }));
    expect(first).toEqual(second);
    expect(first).toEqual({ messages: [
      { role: "user", content: "next" },
      { role: "system", content: "restored segment" },
    ] });
  });

  it("rebuilds from the canonical transcript when checkpoint restoration is unavailable", async () => {
    const pi = new FakePi();
    const rebuildFromCanonical = vi.fn((request) => ({
      status: "rebuilt" as const,
      messages: request.canonicalMessages,
    }));
    createPiExtension({
      engine: {
        restoreCheckpoint: () => ({ status: "unavailable" }),
        rebuildFromCanonical,
        enhanceContext: (request) => request.recoveryMessages,
      },
    })(pi);
    const context = fakeContext();
    context.sessionManager.getBranch = () => [
      { type: "message", message: { role: "user", content: "lossless tool transcript" } },
      { type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: checkpoint("periodic", {
        frameworkSessionId: "/sessions/one.jsonl",
      }) },
    ];

    await pi.emit("session_start", { reason: "resume" }, context);
    const result = await pi.emit("context", { messages: [] }, context);

    expect(rebuildFromCanonical).toHaveBeenCalledWith(expect.objectContaining({
      canonicalMessages: [{ role: "user", content: "lossless tool transcript" }],
    }));
    expect(result).toEqual({ messages: [{ role: "user", content: "lossless tool transcript" }] });
  });

  it("rebuilds after checkpoint validation or loading throws", async () => {
    const pi = new FakePi();
    const rebuildFromCanonical = vi.fn(() => ({
      status: "rebuilt" as const,
      messages: [{ role: "system", content: "rebuilt" }],
    }));
    createPiExtension({
      engine: {
        restoreCheckpoint: () => { throw new Error("checkpoint hash mismatch"); },
        rebuildFromCanonical,
        enhanceContext: (request) => request.recoveryMessages,
      },
    })(pi);
    const context = fakeContext();
    context.sessionManager.getBranch = () => [{
      type: "custom",
      customType: CHECKPOINT_CUSTOM_TYPE,
      data: checkpoint("periodic", { frameworkSessionId: "/sessions/one.jsonl" }),
    }];

    await pi.emit("session_start", { reason: "resume" }, context);
    const result = await pi.emit("context", { messages: [] }, context);

    expect(rebuildFromCanonical).toHaveBeenCalledOnce();
    expect(result).toEqual({ messages: [{ role: "system", content: "rebuilt" }] });
    expect(context.ui?.notify).toHaveBeenCalledWith(
      expect.stringContaining("checkpoint hash mismatch"),
      "warning",
    );
  });

  it("selects recovery state independently for a changed Pi tree leaf", async () => {
    const pi = new FakePi();
    const restoreCheckpoint = vi.fn((request) => ({
      status: "restored" as const,
      messages: [{ role: "system", content: request.pointer?.checkpointId }],
    }));
    createPiExtension({
      engine: {
        restoreCheckpoint,
        enhanceContext: (request) => request.recoveryMessages,
        createCheckpoint: () => undefined,
      },
    })(pi);
    const context = fakeContext();
    let leaf = "leaf-a";
    context.sessionManager.getLeafId = () => leaf;
    context.sessionManager.getBranch = () => [{
      type: "custom",
      customType: CHECKPOINT_CUSTOM_TYPE,
      data: checkpoint("tree_change", {
        frameworkSessionId: "/sessions/one.jsonl",
        checkpointId: leaf,
      }),
    }];

    await pi.emit("session_start", { reason: "resume" }, context);
    leaf = "leaf-b";
    await pi.emit("session_tree", { newLeafId: "leaf-b", oldLeafId: "leaf-a" }, context);
    const result = await pi.emit("context", { messages: [] }, context);

    expect(restoreCheckpoint).toHaveBeenLastCalledWith(expect.objectContaining({
      reason: "tree_change",
      threadId: "leaf-b",
      pointer: expect.objectContaining({ checkpointId: "leaf-b" }),
    }));
    expect(result).toEqual({ messages: [{ role: "system", content: "leaf-b" }] });
  });

  it("keeps a stable thread identity while Pi's append-only leaf advances", async () => {
    const pi = new FakePi();
    const handleEvent = vi.fn();
    createPiExtension({ engine: { handleEvent } })(pi);
    const context = fakeContext();
    let leaf = "initial-leaf";
    context.sessionManager.getLeafId = () => leaf;
    context.sessionManager.getBranch = () => [];

    await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
    leaf = "new-message-entry";
    await pi.emit("turn_end", { type: "turn_end", turnIndex: 0 }, context);

    expect(handleEvent.mock.calls.map(([event]) => event.threadId)).toEqual(["initial-leaf", "initial-leaf"]);
  });
});
