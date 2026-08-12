import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryContextProjector } from "./context/memory-projector.js";
import {
  CollapseController,
  createToolResultBudgetState,
  emptySessionMemory,
  forkSessionMemory,
  restoreToolResultBudgetState,
  updateSessionMemory,
  type CollapseSnapshot,
  type ToolResultReplacementDecision,
} from "./memory/short-term/index.js";
import { createMemoryRecord } from "./memory/long-term/records/memory-record.js";
import { SqliteFtsMemoryIndex } from "./memory/long-term/recall/sqlite-fts-index.js";
import type { AgentMessage, ContextRequest } from "./protocol/index.js";
import { LocalAgentEngramRuntime } from "./runtime/local-agent-engram-runtime.js";
import { sha256, type JsonValue } from "./storage/serialization.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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

function request(messages: readonly AgentMessage[], contextWindow = 200_000): ContextRequest {
  return {
    requestId: "golden-request",
    sessionId: "golden-session",
    threadId: "golden-thread",
    mode: "managed-context",
    canonicalMessages: messages,
    frameworkMessages: messages,
    capabilities,
    contextWindow,
    metadata: { projectId: "project-a" },
  };
}

function text(id: string, role: AgentMessage["role"], value: string, createdAt?: string): AgentMessage {
  return { id, role, content: [{ type: "text", text: value }], ...(createdAt ? { createdAt } : {}) };
}

function fixedToolTranscript(): readonly AgentMessage[] {
  const old = "2026-06-22T00:00:00.000Z";
  return [
    text("system", "system", "stable system instruction"),
    text("old-user", "user", "old context ".repeat(2_000)),
    { id: "call-1", role: "assistant", createdAt: old, content: [{ type: "tool-call", id: "tool-1", name: "read", arguments: {} }] },
    { id: "result-1", role: "tool", content: [{ type: "tool-result", toolCallId: "tool-1", output: "large result ".repeat(100) }] },
    text("middle-user", "user", "middle question"),
    { id: "call-2", role: "assistant", createdAt: old, content: [{ type: "tool-call", id: "tool-2", name: "read", arguments: {} }] },
    { id: "result-2", role: "tool", content: [{ type: "tool-result", toolCallId: "tool-2", output: "recent result" }] },
    text("current-user", "user", "continue from the current task"),
  ];
}

describe("V1 golden short-term projection", () => {
  it("keeps the documented Tool Budget -> Snip -> Microcompact decision order", async () => {
    const messages = fixedToolTranscript();
    const decisions: string[] = [];
    const projector = new MemoryContextProjector({
      toolResultBudget: {
        state: createToolResultBudgetState(),
        options: {
          maxTokensPerMessage: 40,
          estimator: (value) => typeof value === "string" ? value.length : JSON.stringify(value).length,
          offloader: { put: async (id) => ({ uri: `blob://${id}`, preview: `offloaded:${id}` }) },
        },
      },
      historySnip: () => ({ targetTokensToFree: 100, protectedTailTokens: 10 }),
      microcompact: () => ({
        now: new Date("2026-06-22T01:00:00.000Z"),
        coldAfterMs: 1_000,
        keepRecentToolResults: 1,
      }),
      decisions: { append: (kind) => { decisions.push(kind); } },
    });

    const projected = await projector.project({ request: request(messages), mode: "managed-context", messages });

    expect(decisions).toEqual(["tool-result-replacement", "history-snip", "microcompact"]);
    expect(projected.map(({ id }) => id)).toEqual([
      "system",
      expect.stringMatching(/^snip-boundary:/),
      "call-1",
      "result-1",
      "middle-user",
      "call-2",
      "result-2",
      "current-user",
    ]);
    expect(projected.find(({ id }) => id === "result-1")?.content[0]).toMatchObject({
      type: "tool-result",
      output: "[Old tool result content cleared]",
    });
    // Canonical history is never rewritten by a read-time projection.
    expect(JSON.stringify(messages)).toContain("large result");
  });

  it("projects a staged Collapse span deterministically", async () => {
    const messages = Array.from({ length: 9 }, (_, index) =>
      text(`turn-${index}`, "user", `${index}`.repeat(12_000)),
    );
    const collapse = new CollapseController({
      effectiveWindowTokens: 32_000,
      now: () => new Date("2026-06-22T01:00:00.000Z"),
      idFactory: ({ startEventId, endEventId }) => `golden:${startEventId}:${endEventId}`,
      summarizer: { summarize: async ({ candidate }) => ({ summary: `collapsed:${candidate.groupIds.join(",")}` }) },
    });
    const decisions: string[] = [];
    const projector = new MemoryContextProjector({
      collapse,
      decisions: { append: (kind) => { decisions.push(kind); } },
    });

    const projected = await projector.project({ request: request(messages, 32_000), mode: "managed-context", messages });

    expect(decisions).toEqual(["collapse.staged", "collapse.committed"]);
    expect(projected.some(({ id }) => id.startsWith("collapse-summary:golden:"))).toBe(true);
    expect(collapse.snapshot().commits[0]).toMatchObject({ state: "projected", commitSequence: 1 });
  });

  it("uses Compact as the deterministic fallback when Collapse is unavailable", async () => {
    const messages = [
      text("old-1", "user", "a".repeat(16_000)),
      text("old-2", "assistant", "b".repeat(16_000)),
      text("tail", "user", "continue"),
    ];
    const decisions: string[] = [];
    const summarize = vi.fn(async () => ({ text: "golden compact summary", model: "current-model" }));
    const projector = new MemoryContextProjector({
      compact: { summarizer: { summarize }, keepRecentTokens: 2 },
      decisions: { append: (kind) => { decisions.push(kind); } },
    });

    const projected = await projector.project({ request: request(messages, 8_000), mode: "managed-context", messages });

    expect(decisions).toEqual(["compact.completed"]);
    expect(projected.map(({ id }) => id)).toEqual([expect.stringMatching(/^compact-summary:/), "tail"]);
    expect(projected[0]?.content[0]).toEqual({ type: "text", text: "golden compact summary" });
    expect(summarize).toHaveBeenCalledOnce();
  });
});

describe("V1 golden recovery and compatibility", () => {
  it("keeps the projected view identical across checkpoint resume", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-golden-resume-"));
    temporaryDirectories.push(homeDir);
    const summarizer = { summarize: async () => ({ text: "stable summary", model: "current-model" }) };
    const messages = [text("u1", "user", "old ".repeat(4_000)), text("u2", "user", "continue")];
    const runtime = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a", summarizer });
    const compacted = await runtime.compact({
      sessionId: "golden-session",
      threadId: "golden-thread",
      messages,
      keepRecentTokens: 2,
    });
    const before = await runtime.buildContext(request(compacted.messages, 32_000));
    const pointer = await runtime.createCheckpoint({
      sessionId: "golden-session",
      threadId: "golden-thread",
      reason: "post_compact",
      messages: before.messages,
    });
    await runtime.close();

    const resumed = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a", summarizer });
    const recovery = await resumed.recover(pointer);
    expect(recovery).toMatchObject({ status: "restored", messages: before.messages });
    const after = await resumed.buildContext(request(recovery.messages, 32_000));
    expect(after.messages).toEqual(before.messages);
    await resumed.close();
  });

  it("forks SessionMemory by deep value copy", () => {
    const parent = updateSessionMemory(emptySessionMemory(new Date("2026-06-22T00:00:00.000Z")), {
      goals: ["ship"],
      decisions: ["FTS5"],
      verificationState: { status: "partial", checks: ["typecheck"] },
    });
    const child = forkSessionMemory(parent, new Date("2026-06-22T01:00:00.000Z"));
    (child.goals as string[]).push("child-only");
    (child.verificationState.checks as string[]).push("child-test");

    expect(parent.goals).toEqual(["ship"]);
    expect(parent.verificationState.checks).toEqual(["typecheck"]);
    expect(child.updatedAt).not.toBe(parent.updatedAt);
  });

  it("replays decisions from an older algorithm snapshot", () => {
    const legacy: ToolResultReplacementDecision = {
      kind: "tool-result-replacement",
      toolCallId: "legacy-call",
      replacement: { type: "tool-result", toolCallId: "legacy-call", output: "legacy reference" },
      originalTokens: 10_000,
      algorithmVersion: "tool-budget-v0",
      configVersion: "legacy-config",
    };
    const restored = restoreToolResultBudgetState([], [legacy]);
    expect(restored.replacements.get("legacy-call")).toEqual(legacy);

    const legacyCollapse: CollapseSnapshot = {
      version: 1,
      lastObservedTokens: 30_000,
      lastSpawnTokens: 24_000,
      nextCommitSequence: 2,
      staged: [],
      commits: [{
        id: "legacy", startEventId: "old", endEventId: "old", groupIds: ["turn:old"], originalTokens: 5_000,
        summary: "legacy collapse", risk: 0, state: "committed", stagedAt: "2026-01-01T00:00:00.000Z",
        committedAt: "2026-01-01T00:00:01.000Z", commitSequence: 1,
        algorithmVersion: "collapse-v0", configVersion: "legacy-config",
      }],
    };
    const controller = new CollapseController({
      effectiveWindowTokens: 32_000,
      snapshot: legacyCollapse,
      summarizer: { summarize: async () => ({ summary: "unused" }) },
    });
    expect(controller.project([text("old", "user", "original"), text("tail", "user", "current")]))
      .toEqual([expect.objectContaining({ id: "collapse-summary:legacy" }), expect.objectContaining({ id: "tail" })]);
  });

  it("degrades to rebuild when a checkpoint snapshot is corrupt", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-golden-corrupt-"));
    temporaryDirectories.push(homeDir);
    const runtime = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a" });
    const pointer = await runtime.createCheckpoint({
      sessionId: "golden-session",
      threadId: "golden-thread",
      reason: "periodic",
      messages: [text("current", "user", "current")],
    });
    await runtime.close();
    const checkpointPath = join(
      homeDir, "projects", "project-a", "threads", "golden-session", "golden-thread", "checkpoints", `${pointer.checkpointId}.json`,
    );
    await writeFile(checkpointPath, "{corrupt", "utf8");

    const resumed = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a" });
    await expect(resumed.recover(pointer)).resolves.toMatchObject({ status: "rebuild", reason: "checkpoint corrupt" });
    await resumed.close();
  });

  it("degrades to rebuild when a versioned Collapse snapshot violates commit ordering", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-golden-collapse-corrupt-"));
    temporaryDirectories.push(homeDir);
    const runtime = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a" });
    const originalPointer = await runtime.createCheckpoint({
      sessionId: "golden-session",
      threadId: "golden-thread",
      reason: "periodic",
      messages: [text("current", "user", "current")],
    });
    await runtime.close();
    const checkpointPath = join(
      homeDir, "projects", "project-a", "threads", "golden-session", "golden-thread", "checkpoints", `${originalPointer.checkpointId}.json`,
    );
    const stored = JSON.parse(await readFile(checkpointPath, "utf8")) as {
      checkpoint: { state: Record<string, unknown> } & Record<string, JsonValue>;
      checkpointHash: string;
    };
    stored.checkpoint.state.collapse = [{
      effectiveWindowTokens: 32_000,
      snapshot: {
        version: 1, lastObservedTokens: 30_000, lastSpawnTokens: 24_000, nextCommitSequence: 3, staged: [],
        commits: [{
          id: "bad", startEventId: "old", endEventId: "old", groupIds: ["turn:old"], originalTokens: 5_000,
          summary: "bad", risk: 0, state: "committed", stagedAt: "2026-01-01T00:00:00.000Z",
          committedAt: "2026-01-01T00:00:01.000Z", commitSequence: 2,
          algorithmVersion: "collapse-v0", configVersion: "legacy-config",
        }],
      },
    }];
    stored.checkpointHash = sha256(stored.checkpoint as JsonValue);
    await writeFile(checkpointPath, `${JSON.stringify(stored)}\n`, "utf8");
    const pointer = { ...originalPointer, checkpointHash: stored.checkpointHash };

    const resumed = await LocalAgentEngramRuntime.create({ homeDir, projectId: "project-a" });
    await expect(resumed.recover(pointer)).resolves.toMatchObject({ status: "rebuild" });
    await resumed.close();
  });
});

describe("V1 golden long-term recall isolation", () => {
  it("never recalls another project's memory with the same logical id", () => {
    const index = new SqliteFtsMemoryIndex(":memory:");
    const base = {
      id: "shared-id",
      name: "Context policy",
      description: "Project context policy",
      type: "project" as const,
      scope: "project" as const,
      kind: "decision" as const,
      sourceRefs: ["golden"],
    };
    index.upsert(createMemoryRecord({ ...base, projectId: "project-a", content: "alpha isolated policy" }));
    index.upsert(createMemoryRecord({ ...base, projectId: "project-b", content: "beta isolated policy" }));

    expect(index.search({ text: "isolated policy", projectId: "project-a" }).map(({ record }) => record.content))
      .toEqual(["alpha isolated policy"]);
    expect(index.search({ text: "isolated policy", projectId: "project-b" }).map(({ record }) => record.content))
      .toEqual(["beta isolated policy"]);
    expect(index.search({ text: "isolated policy" })).toEqual([]);
    index.close();
  });
});
