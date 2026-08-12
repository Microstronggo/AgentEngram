import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../protocol/message.js";
import {
  applyToolResultBudget,
  CollapseController,
  compactTranscript,
  createToolResultBudgetState,
  emptySessionMemory,
  extractAndSaveSessionMemory,
  extractSessionMemory,
  forkSessionMemory,
  historySnip,
  microcompact,
  recoverContextOverflow,
  replaySnip,
  restoreToolResultBudgetState,
  updateSessionMemory,
  type TurnGroup,
} from "./index.js";

const estimator = (value: unknown): number => typeof value === "string" ? value.length : JSON.stringify(value).length;
const text = (id: string, value: string, role: AgentMessage["role"] = "user", createdAt?: string): AgentMessage => ({
  id, role, content: [{ type: "text", text: value }], ...(createdAt ? { createdAt } : {}),
});
const toolCall = (id: string, toolId: string, name = "Shell"): AgentMessage => ({
  id, role: "assistant", content: [{ type: "tool-call", id: toolId, name, arguments: {} }],
});
const toolResult = (id: string, toolId: string, output: string, createdAt?: string): AgentMessage => ({
  id, role: "tool", content: [{ type: "tool-result", toolCallId: toolId, output }], ...(createdAt ? { createdAt } : {}),
});

describe("Tool Result Budget", () => {
  it("offloads largest fresh results and reapplies byte-identical decisions", async () => {
    const state = createToolResultBudgetState();
    const offloader = { put: vi.fn(async (id: string) => ({ uri: `blob://${id}`, preview: `preview:${id}` })) };
    const source = [toolCall("a", "t1"), toolCall("b", "t2"), {
      id: "results", role: "tool", content: [
        { type: "tool-result", toolCallId: "t1", output: "x".repeat(80) },
        { type: "tool-result", toolCallId: "t2", output: "y".repeat(40) },
      ],
    } satisfies AgentMessage];
    const first = await applyToolResultBudget(source, state, { maxTokensPerMessage: 50, offloader, estimator });
    expect(first.decisions.map((d) => d.toolCallId)).toEqual(["t1"]);
    expect(first.messages[2]?.content[0]).toMatchObject({ output: "preview:t1" });
    const second = await applyToolResultBudget(source, state, { maxTokensPerMessage: 10, offloader, estimator });
    expect(second.decisions).toHaveLength(0);
    expect(second.messages[2]?.content[0]).toMatchObject({ output: "preview:t1" });
    expect(offloader.put).toHaveBeenCalledTimes(1);
  });

  it("restores replacements while freezing previously visible full results", () => {
    const messages = [toolResult("r1", "t1", "full"), toolResult("r2", "t2", "full")];
    const state = restoreToolResultBudgetState(messages, [{
      kind: "tool-result-replacement", toolCallId: "t1",
      replacement: { type: "tool-result", toolCallId: "t1", output: "stable" },
      originalTokens: 4, algorithmVersion: "v1", configVersion: "v1",
    }]);
    expect(state.seenIds).toEqual(new Set(["t1", "t2"]));
    expect(state.replacements.get("t1")?.replacement.output).toBe("stable");
  });
});

describe("History Snip", () => {
  it("records exact removed IDs, protects tail and deterministically replays", () => {
    const source = [text("system", "s"), text("old-1", "1234"), text("old-2", "5678"), text("tail", "recent")];
    const result = historySnip(source, { targetTokensToFree: 8, protectedTailTokens: 6, estimator });
    expect(result.decision?.removedEventIds).toEqual(["old-1", "old-2"]);
    expect(result.messages.map((m) => m.id)).toEqual(["system", expect.stringContaining("snip-boundary"), "tail"]);
    expect(replaySnip(source, result.decision!)).toEqual([source[0], source[3]]);
    expect(result.decision?.rewiredParentByEventId).toEqual({ tail: "system" });
  });

  it("does not remove an unresolved tool call", () => {
    const source = [text("system", "s"), toolCall("active", "pending"), text("old", "large"), text("tail", "recent")];
    expect(historySnip(source, { targetTokensToFree: 4, protectedTailTokens: 6, estimator }).decision).toBeUndefined();
  });
});

describe("Microcompact", () => {
  const source = [
    toolCall("c1", "t1"), toolResult("r1", "t1", "old"),
    toolCall("c2", "t2"), toolResult("r2", "t2", "recent"),
    text("assistant", "done", "assistant", "2026-01-01T00:00:00.000Z"),
  ];
  it("clears old results when the provider cache is cold", async () => {
    const result = await microcompact(source, { now: new Date("2026-01-01T01:00:00Z"), coldAfterMs: 1_000, keepRecentToolResults: 1 });
    expect(result.decision?.strategy).toBe("time-based");
    expect(result.messages[1]?.content[0]).toMatchObject({ output: "[Old tool result content cleared]" });
  });
  it("emits provider cache edits without mutating canonical content", async () => {
    const provider = { supported: true, deleteToolResults: vi.fn(async () => ({ deleted: 1 })) };
    const result = await microcompact(source, { now: new Date("2026-01-01T00:00:00.500Z"), coldAfterMs: 1_000,
      keepRecentToolResults: 1, providerCacheEdit: provider, preferProviderCacheEdit: true });
    expect(result.decision?.strategy).toBe("provider-cache-edit");
    expect(result.messages).toBe(source);
    expect(provider.deleteToolResults).toHaveBeenCalledWith(["t1"]);
  });
});

describe("Session Memory and Compact", () => {
  it("maintains structured task state through an extractor", async () => {
    const previous = updateSessionMemory(emptySessionMemory(), { goals: ["ship"], decisions: ["FTS5"] });
    const memory = await extractSessionMemory({ extract: async () => ({ goals: ["ship", "ship"], pendingTasks: ["tests"] }) }, ["event"], previous);
    expect(memory.goals).toEqual(["ship"]);
    expect(memory.decisions).toEqual(["FTS5"]);
    expect(memory.pendingTasks).toEqual(["tests"]);
  });

  it("persists extraction and forks session state by value", async () => {
    let saved = updateSessionMemory(undefined, { goals: ["parent"] });
    const repository = { load: async () => saved, save: async (_id: string, memory: typeof saved) => { saved = memory; } };
    await extractAndSaveSessionMemory({ sessionId: "s", messages: [], repository,
      extractor: { extract: async () => ({ completedWork: ["implemented"] }) } });
    expect(saved.completedWork).toEqual(["implemented"]);
    const child = forkSessionMemory(saved);
    expect(child).not.toBe(saved);
    expect(child.goals).toEqual(["parent"]);
  });

  it("summarizes the old prefix, preserves a tool pair and emits rehydration metadata", async () => {
    const source = [text("old", "old context"), toolCall("call", "t1"), toolResult("result", "t1", "ok"), text("tail", "recent")];
    const summarize = vi.fn(async () => ({ text: "goal and decisions", model: "current-model" }));
    const result = await compactTranscript(source, { keepRecentTokens: 8, summarizer: { summarize }, estimator });
    expect(result.messages.map((m) => m.id)).toEqual([expect.stringContaining("compact-summary"), "call", "result", "tail"]);
    expect(result.boundary.manifest.compactedEventIds).toEqual(["old"]);
    expect(result.boundary.firstKeptEventId).toBe("call");
    expect(result.boundary.summaryModel).toBe("current-model");
  });
});

describe("Context Collapse", () => {
  const groups: TurnGroup[] = Array.from({ length: 10 }, (_, index) => ({
    id: `g${index}`, startEventId: `m${index}`, endEventId: `m${index}`, tokenCount: 20_000,
    currentRelevance: 0.1, hasCompleteToolPairs: true,
  }));
  const messages = groups.map((_, index) => text(`m${index}`, `message ${index}`));

  it("stages, commits in order, projects at read time and restores snapshots", async () => {
    const controller = new CollapseController({ effectiveWindowTokens: 200_000,
      summarizer: { summarize: async ({ candidate }) => ({ summary: `summary ${candidate.groupIds.join(",")}` }) } });
    expect(await controller.stageIfNeeded({ tokens: 145_000, groups, messages })).toMatchObject({ state: "staged" });
    expect(controller.project(messages)).toEqual(messages);
    const commits = controller.commitIfNeeded(185_000);
    expect(commits[0]).toMatchObject({ state: "committed", commitSequence: 1 });
    expect(controller.project(messages).some((m) => m.id.startsWith("collapse-summary:"))).toBe(true);
    expect(controller.snapshot().commits[0]?.state).toBe("projected");
    const restored = new CollapseController({ effectiveWindowTokens: 200_000, summarizer: { summarize: async () => ({ summary: "x" }) }, snapshot: controller.snapshot() });
    expect(restored.snapshot().commits).toHaveLength(1);
  });

  it("drains before reactive compact and guards both retries", () => {
    const drain = vi.fn(() => true);
    const compact = vi.fn(() => true);
    const initial = { collapseDrainAttempted: false, reactiveCompactAttempted: false };
    const first = recoverContextOverflow({ state: initial, drainCollapse: drain, reactiveCompact: compact });
    expect(first.action).toBe("collapse-drain-retry");
    const second = recoverContextOverflow({ state: first.state, drainCollapse: drain, reactiveCompact: compact });
    expect(second.action).toBe("reactive-compact-retry");
    const third = recoverContextOverflow({ state: second.state, drainCollapse: drain, reactiveCompact: compact });
    expect(third.action).toBe("fail");
    expect(drain).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledTimes(1);
  });
});
