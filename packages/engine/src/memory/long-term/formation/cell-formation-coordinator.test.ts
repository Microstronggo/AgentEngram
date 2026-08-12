import { describe, expect, it, vi } from "vitest";
import type { NormalizedTranscriptEntry } from "../../../transcript/normalized-transcript-entry.js";
import { CellBoundaryDetector } from "./cell-boundary.js";
import { CellFormationCoordinator } from "./cell-formation-coordinator.js";
import { PermanentCellFormationError } from "./cell-formation-coordinator.js";
import { emptyCellFormationState, type CellFormationState } from "./cell-formation-state.js";
import type { CellFormationStateIdentity, CellFormationStateRepository } from "./cell-formation-state-repository.js";
import type { MemoryRecord } from "../records/memory-record.js";
import type { MemoryCandidate } from "./memory-formation.js";

describe("CellFormationCoordinator", () => {
  it("persists an ambiguous Tail and closes it with the next transcript batch", async () => {
    const transcripts = new MemoryTranscriptSource();
    const states = new MemoryStateRepository();
    const decisions = [
      { boundaries: [] as number[], shouldWait: true },
      { boundaries: [2], shouldWait: true },
    ];
    const detector = new CellBoundaryDetector({
      model: { decide: async () => decisions.shift()! },
      idFactory: (seed) => `cell-${seed.length}`,
    });
    const episodeCalls = vi.fn(async () => ({ results: [], episode: episode("episode-1") }));
    const derivedCalls = vi.fn(async () => []);
    const coordinator = new CellFormationCoordinator({
      projectId: "project-a",
      transcripts,
      states,
      boundaryDetector: detector,
      formation: {
        formEpisode: episodeCalls,
        extractDerived: derivedCalls,
        formDerivedCandidate: async () => [],
      },
    });

    transcripts.entries.push(entry("u1", "user", "Start managed-context validation."));
    await expect(coordinator.schedule({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({ status: "idle" });
    expect((await states.load({ sessionId: "s1", threadId: "t1" })).tail.map(({ id }) => id)).toEqual(["u1"]);

    transcripts.entries.push(
      entry("a1", "assistant", "Validation passed."),
      entry("u2", "user", "Now discuss LoCoMo."),
    );
    await expect(coordinator.schedule({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({
      status: "completed",
      closedCells: 1,
      completedCells: 1,
      pendingCells: 0,
    });
    const state = await states.load({ sessionId: "s1", threadId: "t1" });
    expect(state.transcriptCursor).toBe("u2");
    expect(state.tail.map(({ id }) => id)).toEqual(["u2"]);
    expect(episodeCalls).toHaveBeenCalledOnce();
    expect(derivedCalls).toHaveBeenCalledOnce();
  });

  it("retries only the derived stage after the parent Episode is durable", async () => {
    const transcripts = new MemoryTranscriptSource();
    transcripts.entries.push(entry("u1", "user", "Always ask before committing changes."));
    const states = new MemoryStateRepository();
    const episodeCalls = vi.fn(async () => ({ results: [], episode: episode("episode-1") }));
    const derivedCalls = vi.fn()
      .mockRejectedValueOnce(new Error("derived extraction failed"))
      .mockResolvedValueOnce([]);
    const coordinator = new CellFormationCoordinator({
      projectId: "project-a",
      transcripts,
      states,
      boundaryDetector: new CellBoundaryDetector({ model: { decide: async () => ({ boundaries: [], shouldWait: true }) } }),
      formation: {
        formEpisode: episodeCalls,
        extractDerived: derivedCalls,
        formDerivedCandidate: async () => [],
      },
      retryBaseDelayMs: 0,
    });

    await expect(coordinator.flush({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({
      status: "failed",
      pendingCells: 1,
    });
    await expect(states.load({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({
      transcriptCursor: "u1",
      tail: [],
      pendingCells: [{ stage: "derived", episode: { id: "episode-1" }, attempts: 1 }],
    });

    await expect(coordinator.schedule({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({
      status: "completed",
      completedCells: 1,
      pendingCells: 0,
    });
    expect(episodeCalls).toHaveBeenCalledOnce();
    expect(derivedCalls).toHaveBeenCalledTimes(2);
  });

  it("does not advance durable state when boundary detection fails", async () => {
    const transcripts = new MemoryTranscriptSource();
    transcripts.entries.push(entry("u1", "user", "A new task."));
    const states = new MemoryStateRepository();
    const coordinator = new CellFormationCoordinator({
      projectId: "project-a",
      transcripts,
      states,
      boundaryDetector: { detect: async () => { throw new Error("boundary failed"); } },
      formation: {
        formEpisode: async () => ({ results: [] }),
        extractDerived: async () => [],
        formDerivedCandidate: async () => [],
      },
    });

    await expect(coordinator.schedule({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({ status: "failed" });
    await expect(states.load({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({
      tail: [],
      pendingCells: [],
    });
    expect((await states.load({ sessionId: "s1", threadId: "t1" })).transcriptCursor).toBeUndefined();
  });

  it("retries transient boundary failures up to three times before advancing the cursor", async () => {
    const transcripts = new MemoryTranscriptSource();
    transcripts.entries.push(entry("u1", "user", "A completed task."));
    const states = new MemoryStateRepository();
    const detect = vi.fn()
      .mockRejectedValueOnce(new Error("malformed boundary JSON"))
      .mockRejectedValueOnce(new Error("malformed boundary JSON"))
      .mockResolvedValueOnce({ cells: [], tail: [] });
    const coordinator = new CellFormationCoordinator({
      projectId: "project-a",
      transcripts,
      states,
      boundaryDetector: { detect },
      formation: emptyFormation(),
    });

    await expect(coordinator.schedule({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({ status: "idle" });
    expect(detect).toHaveBeenCalledTimes(3);
    expect((await states.load({ sessionId: "s1", threadId: "t1" })).transcriptCursor).toBe("u1");
  });

  it("persists derived candidates and resumes at the candidate cursor without re-extraction", async () => {
    const transcripts = new MemoryTranscriptSource();
    transcripts.entries.push(entry("u1", "user", "Remember the durable rule and fact."));
    const states = new MemoryStateRepository();
    const candidates = [candidate("one"), candidate("two")];
    const extractDerived = vi.fn(async () => candidates);
    const writeCandidate = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("temporary markdown failure"))
      .mockResolvedValueOnce([]);
    const coordinator = new CellFormationCoordinator({
      projectId: "project-a",
      transcripts,
      states,
      boundaryDetector: new CellBoundaryDetector({ model: { decide: async () => ({ boundaries: [], shouldWait: true }) } }),
      formation: {
        formEpisode: async () => ({ results: [], episode: episode("episode-1") }),
        extractDerived,
        formDerivedCandidate: writeCandidate,
      },
      retryBaseDelayMs: 0,
    });

    await expect(coordinator.flush({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({ status: "failed", pendingCells: 1 });
    await expect(states.load({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({
      pendingCells: [{ stage: "derived", derivedCursor: 1, derivedCandidates: [{ name: "one" }, { name: "two" }] }],
    });
    await expect(coordinator.schedule({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({
      status: "completed", pendingCells: 0,
    });
    expect(extractDerived).toHaveBeenCalledOnce();
    expect(writeCandidate.mock.calls.map(([, value]) => value.name)).toEqual(["one", "two", "two"]);
  });

  it("dead-letters a permanent Cell and continues with later ready Cells", async () => {
    const states = new MemoryStateRepository();
    states.seed({ sessionId: "s1", threadId: "t1" }, {
      ...emptyCellFormationState(new Date("2026-06-27T00:00:00.000Z")),
      pendingCells: [pendingCell("bad"), pendingCell("good")],
    });
    const coordinator = new CellFormationCoordinator({
      projectId: "project-a",
      transcripts: new MemoryTranscriptSource(),
      states,
      boundaryDetector: { detect: async () => ({ cells: [], tail: [] }) },
      formation: {
        formEpisode: async (cell) => {
          if (cell.id === "bad") throw new PermanentCellFormationError("invalid candidate state");
          return { results: [] };
        },
        extractDerived: async () => [],
        formDerivedCandidate: async () => [],
      },
    });

    await expect(coordinator.schedule({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({
      status: "failed", completedCells: 1, pendingCells: 0, deadLetteredCells: 1,
    });
    await expect(states.load({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({
      deadLetters: [{ cell: { id: "bad" }, errorKind: "permanent" }],
    });
  });

  it("aborts a model-backed stage when the per-thread task times out", async () => {
    const transcripts = new MemoryTranscriptSource();
    transcripts.entries.push(entry("u1", "user", "Final task."));
    let observedAbort = false;
    const coordinator = new CellFormationCoordinator({
      projectId: "project-a",
      transcripts,
      states: new MemoryStateRepository(),
      boundaryDetector: new CellBoundaryDetector({ model: { decide: async () => ({ boundaries: [], shouldWait: true }) } }),
      formation: {
        formEpisode: async (_cell, options) => new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            observedAbort = true;
            reject(options.signal?.reason);
          }, { once: true });
        }),
        extractDerived: async () => [],
        formDerivedCandidate: async () => [],
      },
      taskTimeoutMs: 20,
    });

    await expect(coordinator.flush({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({ status: "failed" });
    expect(observedAbort).toBe(true);
  });

  it("serializes one thread while allowing independent threads to progress concurrently", async () => {
    const states = new MemoryStateRepository();
    states.seed({ sessionId: "s1", threadId: "t1" }, {
      ...emptyCellFormationState(), pendingCells: [pendingCell("one")],
    });
    states.seed({ sessionId: "s1", threadId: "t2" }, {
      ...emptyCellFormationState(), pendingCells: [pendingCell("two")],
    });
    let active = 0;
    let maximumActive = 0;
    const coordinator = new CellFormationCoordinator({
      projectId: "project-a",
      transcripts: new MemoryTranscriptSource(),
      states,
      boundaryDetector: { detect: async () => ({ cells: [], tail: [] }) },
      formation: {
        formEpisode: async () => {
          active++;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          active--;
          return { results: [] };
        },
        extractDerived: async () => [],
        formDerivedCandidate: async () => [],
      },
    });

    await Promise.all([
      coordinator.schedule({ sessionId: "s1", threadId: "t1" }),
      coordinator.schedule({ sessionId: "s1", threadId: "t1" }),
      coordinator.schedule({ sessionId: "s1", threadId: "t2" }),
    ]);
    expect(maximumActive).toBe(2);
    expect((await states.load({ sessionId: "s1", threadId: "t1" })).pendingCells).toEqual([]);
    expect((await states.load({ sessionId: "s1", threadId: "t2" })).pendingCells).toEqual([]);
  });

  it("skips a future retry without blocking a later ready Cell", async () => {
    const now = new Date("2026-06-27T00:00:00.000Z");
    const states = new MemoryStateRepository();
    states.seed({ sessionId: "s1", threadId: "t1" }, {
      ...emptyCellFormationState(now),
      pendingCells: [
        { ...pendingCell("waiting"), nextRetryAt: "2026-06-27T00:01:00.000Z" },
        pendingCell("ready"),
      ],
    });
    const calls: string[] = [];
    const coordinator = new CellFormationCoordinator({
      projectId: "project-a",
      transcripts: new MemoryTranscriptSource(),
      states,
      clock: () => now,
      boundaryDetector: { detect: async () => ({ cells: [], tail: [] }) },
      formation: {
        formEpisode: async (cell) => { calls.push(cell.id); return { results: [] }; },
        extractDerived: async () => [],
        formDerivedCandidate: async () => [],
      },
    });

    await expect(coordinator.schedule({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({
      status: "completed", completedCells: 1, pendingCells: 1,
    });
    expect(calls).toEqual(["ready"]);
  });
});

class MemoryTranscriptSource {
  readonly entries: NormalizedTranscriptEntry[] = [];

  async readNormalizedAfter(input: { readonly threadId: string; readonly cursor?: string }): Promise<readonly NormalizedTranscriptEntry[]> {
    const entries = this.entries.filter(({ threadId }) => threadId === input.threadId);
    if (!input.cursor) return entries;
    const index = entries.findIndex(({ id }) => id === input.cursor);
    if (index < 0) throw new Error("missing cursor");
    return entries.slice(index + 1);
  }
}

class MemoryStateRepository implements CellFormationStateRepository {
  private readonly states = new Map<string, CellFormationState>();

  async load(identity: CellFormationStateIdentity): Promise<CellFormationState> {
    return structuredClone(this.states.get(key(identity)) ?? emptyCellFormationState(new Date("2026-06-27T00:00:00.000Z")));
  }

  async save(identity: CellFormationStateIdentity, state: CellFormationState): Promise<void> {
    this.states.set(key(identity), structuredClone(state));
  }

  seed(identity: CellFormationStateIdentity, state: CellFormationState): void {
    this.states.set(key(identity), structuredClone(state));
  }
}

function entry(id: string, role: string, text: string): NormalizedTranscriptEntry {
  return {
    schemaVersion: 1,
    id,
    sessionId: "s1",
    threadId: "t1",
    sourceRef: `agentengram://transcript/s1/t1/${id}`,
    kind: "message",
    role,
    text,
    contentHash: `hash-${id}`,
    createdAt: "2026-06-27T00:00:00.000Z",
  };
}

function episode(id: string): MemoryRecord {
  return {
    id,
    schemaVersion: 1,
    name: "Episode",
    description: "Episode",
    content: "A durable episode was written.",
    type: "project",
    scope: "project",
    projectId: "project-a",
    memoryClass: "episodic",
    tags: [],
    sourceRefs: ["source:1"],
    status: "active",
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
}

function key(identity: CellFormationStateIdentity): string {
  return `${identity.sessionId}\0${identity.threadId}`;
}

function candidate(name: string): MemoryCandidate {
  return { name, description: name, content: name, type: "project", scope: "project", memoryClass: "factual" };
}

function pendingCell(id: string) {
  return {
    stage: "episode" as const,
    attempts: 0,
    cell: { id, cellType: "episode" as const, trigger: "session" as const, text: id, sourceEntryIds: [`source:${id}`] },
  };
}

function emptyFormation() {
  return {
    formEpisode: async () => ({ results: [] }),
    extractDerived: async () => [],
    formDerivedCandidate: async () => [],
  };
}
