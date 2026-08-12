import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryFormationPipeline } from "../memory/index.js";
import type { LLMChatClient, LLMMessage } from "../llm/index.js";
import type { AgentMessage, ContextRequest, HostModelBridge, HostModelReference } from "../protocol/index.js";
import type { NormalizedTranscriptEntry } from "../transcript/index.js";
import { LocalAgentEngramRuntime } from "./local-agent-engram-runtime.js";

const capabilities = {
  contextHook: true,
  replaceContext: true,
  compactionHook: true,
  replaceCompaction: true,
  sessionLifecycle: true,
  threadLifecycle: true,
  toolLifecycle: true,
  persistentCustomEntries: true,
};

function contextRequest(messages: readonly AgentMessage[], mode: "enhance" | "managed-context" = "enhance"): ContextRequest {
  return {
    requestId: crypto.randomUUID(),
    sessionId: "session-a",
    threadId: "thread-a",
    mode,
    canonicalMessages: messages,
    frameworkMessages: messages,
    capabilities,
    contextWindow: 32_000,
    metadata: { projectId: "project-a" },
  };
}

describe("LocalAgentEngramRuntime", () => {
  it("composes durable long-term recall and session memory into enhance context", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-local-"));
    const extractor = { extract: vi.fn(async () => ({ goals: ["Ship AgentEngram"] })) };
    const runtime = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a", sessionExtractor: extractor });
    await runtime.longTerm.remember({
      id: "decision-1",
      name: "context policy",
      description: "Canonical transcript policy",
      content: "Keep the canonical transcript intact.",
      type: "project",
      scope: "project",
      projectId: "project-a",
      kind: "decision",
      sourceRefs: ["session:1"],
    });
    const messages: AgentMessage[] = [{ id: "u1", role: "user", content: [{ type: "text", text: "What is our context policy?" }] }];
    await runtime.updateSessionMemory({ sessionId: "session-a", messages });

    const view = await runtime.buildContext(contextRequest(messages));

    expect(JSON.stringify(view.messages)).toContain("Ship AgentEngram");
    expect(JSON.stringify(view.messages)).toContain("Keep the canonical transcript intact");
    expect(view.messages[0]).toEqual(messages[0]);
    await runtime.close();
    await expect(runtime.buildContext(contextRequest(messages))).rejects.toThrow("closed");
  });

  it("compacts with the injected current-model summarizer and recovers a durable checkpoint", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-recovery-"));
    const summarizer = { summarize: vi.fn(async () => ({ text: "Goal and decisions preserved", model: "current-model" })) };
    const runtime = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a", summarizer });
    const messages: AgentMessage[] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "old request ".repeat(100) }] },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "old response ".repeat(100) }] },
      { id: "u2", role: "user", content: [{ type: "text", text: "continue" }] },
    ];
    const compacted = await runtime.compact({ sessionId: "session-a", threadId: "thread-a", messages, keepRecentTokens: 2 });
    expect(compacted.messages[0]?.content[0]).toEqual({ type: "text", text: "Goal and decisions preserved" });
    expect(compacted.boundary.summaryModel).toBe("current-model");

    const pointer = await runtime.createCheckpoint({
      sessionId: "session-a",
      threadId: "thread-a",
      reason: "post_compact",
      messages: compacted.messages,
    });
    await runtime.close();

    const resumed = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a", summarizer });
    const recovery = await resumed.recover(pointer);
    expect(recovery.status).toBe("restored");
    expect(recovery.messages).toEqual(compacted.messages);
    expect(summarizer.summarize).toHaveBeenCalledOnce();
    await resumed.close();
  });

  it("offloads oversized managed tool results into the content-addressed blob store", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-blob-"));
    const runtime = await LocalAgentEngramRuntime.create({
      homeDir,
      projectId: "project-a",
      summarizer: { summarize: async () => ({ text: "summary", model: "current" }) },
      toolResultTokenBudget: 10,
    });
    const output = "large".repeat(1_000);
    const messages: AgentMessage[] = [
      { id: "a", role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "read", arguments: {} }] },
      { id: "t", role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", output }] },
      { id: "u", role: "user", content: [{ type: "text", text: "continue" }] },
    ];
    const view = await runtime.buildContext(contextRequest(messages, "managed-context"));
    const serialized = JSON.stringify(view.messages);
    const digest = serialized.match(/blob:sha256:([a-f0-9]{64})/)?.[1];
    expect(digest).toBeDefined();
    const stored = await runtime.blobs.get({
      algorithm: "sha256",
      digest: digest!,
      byteLength: Buffer.byteLength(output),
      mediaType: "text/plain; charset=utf-8",
    });
    expect(stored.toString("utf8")).toBe(output);
    expect(JSON.stringify(messages)).toContain(output);
    await runtime.close();
  });

  it("persists managed-context ownership fallback in the projection log", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-ownership-log-"));
    const runtime = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a" });
    const safe: AgentMessage[] = [{ id: "safe", role: "user", content: [{ type: "text", text: "continue" }] }];
    const invalid: AgentMessage[] = [{
      id: "orphan",
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "missing", output: "unsafe" }],
    }];
    const view = await runtime.buildContext({
      ...contextRequest(invalid, "managed-context"),
      frameworkMessages: safe,
      ownership: {
        requestedMode: "managed-context",
        effectiveMode: "managed-context",
        contextOwner: "agentengram",
        compactionOwner: "agentengram",
        failurePolicy: "host-fallback",
        fallbackCount: 0,
      },
    });

    expect(view.source).toBe("fail-open");
    expect(view.messages).toEqual(safe);
    expect(view.diagnostics?.ownership?.fallbackReason).toBe("context-invalid");
    const log = await readFile(
      join(homeDir, "projects", "project-a", "threads", "session-a", "thread-a", "projection.jsonl"),
      "utf8",
    );
    expect(log).toContain("context.ownership-fallback");
    expect(log).toContain("context-invalid");
    await runtime.close();
  });

  it("applies default time-based microcompact and records the projection decision", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-microcompact-"));
    const runtime = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a" });
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const messages: AgentMessage[] = [];
    for (let index = 0; index < 5; index += 1) {
      messages.push({
        id: `a${index}`,
        role: "assistant",
        createdAt: old,
        content: [{ type: "tool-call", id: `c${index}`, name: "read", arguments: {} }],
      });
      messages.push({
        id: `t${index}`,
        role: "tool",
        content: [{ type: "tool-result", toolCallId: `c${index}`, output: `result-${index}` }],
      });
    }
    messages.push({ id: "u", role: "user", content: [{ type: "text", text: "continue" }] });

    const view = await runtime.buildContext(contextRequest(messages, "managed-context"));

    expect(JSON.stringify(view.messages)).toContain("[Old tool result content cleared]");
    const log = await readFile(join(homeDir, "projects", "project-a", "threads", "session-a", "thread-a", "projection.jsonl"), "utf8");
    expect(log).toContain('"kind":"microcompact"');
    await runtime.close();
  });

  it("uses per-thread Collapse instead of proactive Compact and restores its snapshot", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-collapse-"));
    const summarize = vi.fn(async (input: { instructions: readonly string[] }) => ({
      text: input.instructions[0]?.includes("historical span") ? "collapsed historical span" : "full compact",
      model: "current-model",
    }));
    const runtime = await LocalAgentEngramRuntime.create({
      homeDir,
      projectId: "project-a",
      summarizer: { summarize },
    });
    // 4K first group + 3K middle + 9K protected tail. The conservative Snip
    // policy starts at 32K windows; at 16K Collapse directly owns this pressure.
    const messageSizes = [12_000, 9_000, 27_000];
    const messages: AgentMessage[] = messageSizes.map((size, index) => ({
      id: `u${index}`,
      role: "user" as const,
      content: [{ type: "text" as const, text: `${index}`.repeat(size) }],
    }));
    const request = { ...contextRequest(messages, "managed-context"), contextWindow: 16_000 };

    const view = await runtime.buildContext(request);

    expect(JSON.stringify(view.messages)).toContain("collapsed historical span");
    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({
      instructions: expect.arrayContaining([expect.stringContaining("historical span")]),
    }));
    expect(summarize).not.toHaveBeenCalledWith(expect.objectContaining({
      instructions: expect.arrayContaining([expect.stringContaining("Preserve user goals")]),
    }));
    const logPath = join(homeDir, "projects", "project-a", "threads", "session-a", "thread-a", "projection.jsonl");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain('"kind":"collapse.staged"');
    expect(log).toContain('"kind":"collapse.committed"');

    const pointer = await runtime.createCheckpoint({ sessionId: "session-a", threadId: "thread-a", reason: "periodic" });
    await runtime.close();
    const resumed = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a", summarizer: { summarize } });
    expect((await resumed.recover(pointer)).status).toBe("restored");
    const resumedView = await resumed.buildContext({ ...request, requestId: "resumed" });
    expect(JSON.stringify(resumedView.messages)).toContain("collapsed historical span");
    await resumed.close();
  });

  it("schedules long-term formation on turn completion and drains it into Markdown and FTS", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-formation-runtime-"));
    const extractor = vi.fn(async () => [{
      name: "FTS5 default",
      description: "Project memory backend decision",
      content: "AgentEngram V1 uses FTS5 by default and does not require embeddings.",
      type: "project" as const,
      scope: "project" as const,
      kind: "decision" as const,
      confidence: 0.9,
      projectId: "project-a",
    }]);
    const formation = new MemoryFormationPipeline({
      extractor: { extract: extractor },
      evaluator: { evaluate: async () => ({ save: true, importance: 0.8 }) },
      duplicates: { resolve: async () => ({ action: "write" }) },
      scanner: { scan: async () => ({ allowed: true }) },
      writer: { put: vi.fn(async () => undefined) },
      idFactory: () => "memory-fts5-default",
    });
    const runtime = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a", formation });

    await runtime.handle({
      eventId: "pi-turn-1",
      eventType: "turn.completed",
      timestamp: "2026-06-24T00:00:00.000Z",
      framework: "pi-mono",
      sessionId: "session-a",
      threadId: "thread-a",
      payload: { turnId: "turn-1" },
      metadata: {
        memoryObservation: {
          text: "用户确认：AgentEngram V1 默认只使用 FTS5，不使用 Embedding。",
          sourceRefs: ["agentengram://transcript/session-a/thread-a/entry-u1"],
        },
      },
    });
    await expect(runtime.drainFormation()).resolves.toBe("drained");

    expect(extractor).toHaveBeenCalledOnce();
    await expect(runtime.application.read("project", "memory-fts5-default", "project-a"))
      .resolves.toMatchObject({
        id: "memory-fts5-default",
        content: "AgentEngram V1 uses FTS5 by default and does not require embeddings.",
        sourceRefs: ["agentengram://transcript/session-a/thread-a/entry-u1"],
      });
    expect(runtime.application.search({
      text: "FTS5 embeddings",
      projectId: "project-a",
      scope: "project",
    })[0]?.record.id).toBe("memory-fts5-default");
    await runtime.close();
  });

  it("forms episodic and derived memories from a final transcript Cell and recalls them", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-cell-runtime-"));
    const client = new FormationLLMClient();
    const runtime = await LocalAgentEngramRuntime.create({
      homeDir,
      projectId: "project-a",
      llmClient: client,
    });
    await runtime.transcripts.appendNormalized("session-a", transcriptEntry(
      "u-cell",
      "user",
      "Project convention: always ask before creating a git commit.",
    ));
    await runtime.transcripts.appendNormalized("session-a", transcriptEntry(
      "a-cell",
      "assistant",
      "Understood. I will validate changes and request confirmation before committing.",
    ));

    await expect(runtime.flushCellFormation({ sessionId: "session-a", threadId: "thread-a" }))
      .resolves.toMatchObject({ status: "completed", closedCells: 1, completedCells: 1, pendingCells: 0 });

    const projectMemories = runtime.application.search({
      text: "ask before git commit",
      projectId: "project-a",
      scope: "project",
      limit: 10,
    }).map(({ record }) => record);
    expect(projectMemories.map(({ memoryClass }) => memoryClass)).toEqual(expect.arrayContaining(["episodic", "procedural"]));
    const procedural = projectMemories.find(({ memoryClass }) => memoryClass === "procedural");
    const episode = projectMemories.find(({ memoryClass }) => memoryClass === "episodic");
    expect(procedural?.parentMemoryIds).toEqual([episode?.id]);
    expect(procedural?.sourceRefs).toEqual(expect.arrayContaining([
      "agentengram://transcript/session-a/thread-a/u-cell",
      "agentengram://transcript/session-a/thread-a/a-cell",
    ]));

    const context = await runtime.buildContext(contextRequest([{
      id: "u-next",
      role: "user",
      content: [{ type: "text", text: "Can you create a git commit now?" }],
    }]));
    expect(JSON.stringify(context.messages)).toContain("Ask for explicit user confirmation before creating any git commit");
    expect(client.stages).toEqual(["boundary", "episode", "derived"]);
    await runtime.close();
  });

  it("restores a persisted per-thread Cell Tail after runtime restart", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-cell-restart-"));
    const firstClient = new FormationLLMClient();
    const first = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a", llmClient: firstClient });
    await first.transcripts.appendNormalized("session-a", transcriptEntry(
      "u-before-restart",
      "user",
      "The durable convention is being discussed but is not complete yet.",
    ));
    await expect(first.scheduleCellFormation({ sessionId: "session-a", threadId: "thread-a" }))
      .resolves.toMatchObject({ status: "idle", closedCells: 0 });
    await first.close();

    const resumedClient = new FormationLLMClient();
    const resumed = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a", llmClient: resumedClient });
    await resumed.transcripts.appendNormalized("session-a", transcriptEntry(
      "a-after-restart",
      "assistant",
      "The convention is now confirmed and applies to future git commits.",
    ));
    await expect(resumed.flushCellFormation({ sessionId: "session-a", threadId: "thread-a" }))
      .resolves.toMatchObject({ status: "completed", closedCells: 1 });

    const episode = resumed.application.search({
      text: "commit convention",
      projectId: "project-a",
      scope: "project",
      limit: 10,
    }).map(({ record }) => record).find(({ memoryClass }) => memoryClass === "episodic");
    expect(episode?.sourceRefs).toEqual([
      "agentengram://transcript/session-a/thread-a/u-before-restart",
      "agentengram://transcript/session-a/thread-a/a-after-restart",
    ]);
    await resumed.close();
  });

  it("enqueues sidecar Cell work without invoking the model and lets an external worker drain it", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-cell-sidecar-"));
    const producerClient = new FormationLLMClient();
    const producer = await LocalAgentEngramRuntime.create({
      homeDir,
      projectId: "project-a",
      llmClient: producerClient,
      workerExecutionMode: "sidecar",
    });
    await producer.transcripts.appendNormalized("session-a", transcriptEntry(
      "u-sidecar",
      "user",
      "Always ask before creating a git commit.",
    ));

    const queued = await producer.enqueueCellFormation({
      sessionId: "session-a",
      threadId: "thread-a",
      isFinal: true,
    });

    expect(queued).toMatchObject({ status: "pending", partitionKey: "project-a" });
    expect(producerClient.stages).toEqual([]);
    await producer.close();

    const workerClient = new FormationLLMClient();
    const worker = await LocalAgentEngramRuntime.create({
      homeDir,
      projectId: "project-a",
      llmClient: workerClient,
      workerExecutionMode: "external",
    });
    await expect(worker.runReadyBackgroundJobs()).resolves.toBe(1);
    expect(worker.listBackgroundJobs()).toEqual([
      expect.objectContaining({ jobId: queued?.jobId, status: "completed" }),
    ]);
    expect(workerClient.stages).toEqual(["boundary", "episode", "derived"]);
    await worker.close();
  });

  it("binds every durable Cell stage to the host model captured at enqueue time", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-cell-model-binding-"));
    const modelA = new FormationLLMClient();
    const modelB = new FormationLLMClient();
    let current: HostModelReference = { provider: "pi", model: "model-a", selectedAt: new Date().toISOString() };
    const bridge: HostModelBridge<LLMChatClient> = {
      currentModel: () => current,
      invokeClient: (reference) => reference?.model === "model-a" ? modelA : modelB,
    };
    const producer = await LocalAgentEngramRuntime.create({
      homeDir,
      projectId: "project-a",
      llmClient: modelA,
      modelBridge: bridge,
      workerExecutionMode: "sidecar",
    });
    await producer.transcripts.appendNormalized("session-a", transcriptEntry(
      "u-model-binding",
      "user",
      "Always ask before committing.",
    ));
    const queued = await producer.enqueueCellFormation({
      sessionId: "session-a",
      threadId: "thread-a",
      isFinal: true,
    });
    expect(queued?.payload).toMatchObject({ modelReference: { provider: "pi", model: "model-a" } });
    await producer.close();

    current = { provider: "pi", model: "model-b", selectedAt: new Date().toISOString() };
    const worker = await LocalAgentEngramRuntime.create({
      homeDir,
      projectId: "project-a",
      llmClient: modelB,
      modelBridge: bridge,
      workerExecutionMode: "external",
    });
    await expect(worker.runReadyBackgroundJobs()).resolves.toBe(1);
    expect(modelA.stages).toEqual(["boundary", "episode", "derived"]);
    expect(modelB.stages).toEqual([]);
    await worker.close();
  });

  it("uses TaskModelResolver when a persisted host model cannot be rebound", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-cell-model-fallback-"));
    const unavailable = new FormationLLMClient();
    const configured = new FormationLLMClient();
    const reference: HostModelReference = { provider: "pi", model: "missing-after-restart" };
    const bridge: HostModelBridge<LLMChatClient> = {
      currentModel: () => reference,
      invokeClient: () => undefined,
    };
    const producer = await LocalAgentEngramRuntime.create({
      homeDir,
      projectId: "project-a",
      llmClient: unavailable,
      modelBridge: bridge,
      workerExecutionMode: "sidecar",
    });
    await producer.transcripts.appendNormalized("session-a", transcriptEntry(
      "u-model-fallback",
      "user",
      "Always ask before committing.",
    ));
    await producer.enqueueCellFormation({ sessionId: "session-a", threadId: "thread-a", isFinal: true });
    await producer.close();

    const resolve = vi.fn(async () => ({
      client: configured,
      requestedSource: "host-current" as const,
      source: "configured-provider" as const,
      fallbackReason: "host-current-unavailable" as const,
    }));
    const worker = await LocalAgentEngramRuntime.create({
      homeDir,
      projectId: "project-a",
      llmClient: unavailable,
      modelBridge: bridge,
      taskModelResolver: { resolve },
      workerExecutionMode: "external",
    });
    await expect(worker.runReadyBackgroundJobs()).resolves.toBe(1);
    expect(resolve).toHaveBeenCalledWith("memory-formation", expect.objectContaining({
      metadata: expect.objectContaining({ modelReference: reference }),
    }));
    expect(configured.stages).toEqual(["boundary", "episode", "derived"]);
    expect(unavailable.stages).toEqual([]);
    await worker.close();
  });

  it("isolates durable Cell queues and idempotency keys by project", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-cell-project-jobs-"));
    const createProducer = async (projectId: string) => {
      const runtime = await LocalAgentEngramRuntime.create({
        homeDir,
        projectId,
        workerExecutionMode: "sidecar",
      });
      await runtime.transcripts.appendNormalized("session-a", transcriptEntry(
        "same-entry",
        "user",
        `Evidence for ${projectId}`,
      ));
      return runtime;
    };
    const projectA = await createProducer("project-a");
    const projectB = await createProducer("project-b");
    const jobA = await projectA.enqueueCellFormation({ sessionId: "session-a", threadId: "thread-a", isFinal: true });
    const jobB = await projectB.enqueueCellFormation({ sessionId: "session-a", threadId: "thread-a", isFinal: true });

    expect(jobA?.jobId).not.toBe(jobB?.jobId);
    expect(projectA.listBackgroundJobs()).toHaveLength(1);
    expect(projectB.listBackgroundJobs()).toHaveLength(1);
    await projectA.close();
    await projectB.close();
  });
});

/** Deterministic model double covering boundary, episode, and derived prompts. */
class FormationLLMClient implements LLMChatClient {
  readonly stages: string[] = [];

  async chat(messages: readonly LLMMessage[]) {
    const system = messages[0]?.content ?? "";
    if (system.includes("Cell boundary detector")) {
      this.stages.push("boundary");
      return { content: '{"boundaries":[],"should_wait":true}', model: "fake-qwen" };
    }
    if (system.includes("episodic memory extractor")) {
      this.stages.push("episode");
      return {
        model: "fake-qwen",
        content: JSON.stringify({ candidates: [{
          name: "Commit confirmation convention established",
          description: "The user established a commit-safety convention.",
          content: "The user required AgentEngram to ask before creating git commits, and the assistant accepted the rule.",
          type: "project",
          scope: "project",
          memoryClass: "episodic",
          kind: "decision",
          confidence: 0.95,
        }] }),
      };
    }
    this.stages.push("derived");
    return {
      model: "fake-qwen",
      content: JSON.stringify({ candidates: [{
        name: "Ask before committing",
        description: "Future git commit workflow rule.",
        content: "Ask for explicit user confirmation before creating any git commit.",
        type: "project",
        scope: "project",
        memoryClass: "procedural",
        kind: "convention",
        confidence: 0.98,
      }] }),
    };
  }
}

function transcriptEntry(id: string, role: string, text: string): NormalizedTranscriptEntry {
  return {
    schemaVersion: 1,
    id,
    sessionId: "session-a",
    threadId: "thread-a",
    sourceRef: `agentengram://transcript/session-a/thread-a/${id}`,
    kind: "message",
    role,
    text,
    contentHash: `hash-${id}`,
    createdAt: "2026-06-27T00:00:00.000Z",
  };
}
