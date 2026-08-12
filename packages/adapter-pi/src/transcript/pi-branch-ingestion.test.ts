import { describe, expect, it, vi } from "vitest";
import {
  createHostBinding,
  type SourceCheckpoint,
  type SourceCheckpointRepository,
  type TranscriptAppendInput,
} from "@agentengram/engine";
import { ingestPiBranchIncrementally } from "./pi-branch-ingestion.js";

describe("incremental Pi branch ingestion", () => {
  it("normalizes and appends only entries after the durable cursor", async () => {
    const checkpoints = new MemoryCheckpointRepository();
    const batches: TranscriptAppendInput[][] = [];
    const append = vi.fn(async (entries: readonly TranscriptAppendInput[]) => { batches.push([...entries]); });

    await ingestPiBranchIncrementally({
      sourceId: "pi:project:session:thread",
      sessionId: "session",
      threadId: "thread",
      branchEntries: [entry("e1", "first"), entry("e2", "second")],
      checkpoints,
      append,
      now: fixedClock,
    });
    const second = await ingestPiBranchIncrementally({
      sourceId: "pi:project:session:thread",
      sessionId: "session",
      threadId: "thread",
      branchEntries: [entry("e1", "first"), entry("e2", "second"), entry("e3", "third")],
      checkpoints,
      append,
      now: fixedClock,
    });

    expect(batches).toHaveLength(2);
    expect(batches[0]?.map(({ raw }) => raw.frameworkEntryId)).toEqual(["e1", "e2"]);
    expect(batches[1]?.map(({ raw }) => raw.frameworkEntryId)).toEqual(["e3"]);
    expect(second).toEqual({ appendedEntries: 1, reconciled: false, cursor: "e3" });
    await expect(checkpoints.load("pi:project:session:thread")).resolves.toMatchObject({ cursorValue: "e3" });
  });

  it("replays the active branch when a compact/tree change removed the cursor", async () => {
    const checkpoints = new MemoryCheckpointRepository(checkpoint("missing-entry"));
    const appended: TranscriptAppendInput[] = [];

    const result = await ingestPiBranchIncrementally({
      sourceId: "source",
      sourceVersion: "/sessions/one.jsonl",
      sessionId: "session",
      threadId: "thread",
      branchEntries: [entry("e2", "kept"), entry("e3", "new")],
      checkpoints,
      append: async (entries) => { appended.push(...entries); },
      now: fixedClock,
    });

    expect(result).toEqual({ appendedEntries: 2, reconciled: true, cursor: "e3" });
    expect(appended.map(({ raw }) => raw.frameworkEntryId)).toEqual(["e2", "e3"]);
    await expect(checkpoints.load("source")).resolves.toMatchObject({
      sourceVersion: "/sessions/one.jsonl",
      cursorValue: "e3",
    });
  });

  it("does not advance the source checkpoint when transcript append fails", async () => {
    const checkpoints = new MemoryCheckpointRepository(checkpoint("e1"));

    await expect(ingestPiBranchIncrementally({
      sourceId: "source",
      sessionId: "session",
      threadId: "thread",
      branchEntries: [entry("e1", "first"), entry("e2", "second")],
      checkpoints,
      append: async () => { throw new Error("transcript offline"); },
      now: fixedClock,
    })).rejects.toThrow("transcript offline");

    await expect(checkpoints.load("source")).resolves.toMatchObject({ cursorValue: "e1" });
    expect(checkpoints.save).not.toHaveBeenCalled();
  });

  it("replays the branch when the backing Pi session file changes", async () => {
    const checkpoints = new MemoryCheckpointRepository({
      ...checkpoint("e1"),
      sourceVersion: "/sessions/old.jsonl",
    });
    const appended: TranscriptAppendInput[] = [];

    const result = await ingestPiBranchIncrementally({
      sourceId: "source",
      sourceVersion: "/sessions/new.jsonl",
      sessionId: "session",
      threadId: "thread",
      branchEntries: [entry("e1", "new source reused id"), entry("e2", "new evidence")],
      checkpoints,
      append: async (entries) => { appended.push(...entries); },
      now: fixedClock,
    });

    expect(result).toEqual({ appendedEntries: 2, reconciled: true, cursor: "e2" });
    expect(appended.map(({ raw }) => raw.frameworkEntryId)).toEqual(["e1", "e2"]);
    await expect(checkpoints.load("source")).resolves.toMatchObject({
      sourceVersion: "/sessions/new.jsonl",
      cursorValue: "e2",
    });
  });

  it("persists the trusted HostBinding with transcript provenance and checkpoint state", async () => {
    const checkpoints = new MemoryCheckpointRepository();
    const binding = createHostBinding({
      hostType: "pi",
      hostProjectId: "project",
      hostSessionId: "session",
      hostThreadId: "thread",
      worktreeId: "worktree",
    });
    let appended: readonly TranscriptAppendInput[] = [];

    await ingestPiBranchIncrementally({
      sourceId: "source",
      sessionId: "session",
      threadId: "thread",
      branchEntries: [entry("e1", "bound")],
      hostBinding: binding,
      checkpoints,
      append: async (entries) => { appended = entries; },
      now: fixedClock,
    });

    expect(appended[0]?.raw.metadata).toMatchObject({
      namespaceId: "project",
      hostType: "pi",
      hostProjectId: "project",
      worktreeId: "worktree",
    });
    expect(appended[0]?.normalized?.metadata).toMatchObject({ namespaceId: "project", hostType: "pi" });
    await expect(checkpoints.load("source")).resolves.toMatchObject({
      parserState: { namespaceId: "project", hostType: "pi" },
    });
  });
});

class MemoryCheckpointRepository implements SourceCheckpointRepository {
  private value: SourceCheckpoint | undefined;
  readonly save = vi.fn(async (checkpointValue: SourceCheckpoint) => { this.value = checkpointValue; });

  constructor(initial?: SourceCheckpoint) {
    this.value = initial;
  }

  async load(sourceId: string): Promise<SourceCheckpoint | undefined> {
    return this.value?.sourceId === sourceId ? this.value : undefined;
  }

  async remove(sourceId: string): Promise<void> {
    if (this.value?.sourceId === sourceId) this.value = undefined;
  }
}

function checkpoint(cursorValue: string): SourceCheckpoint {
  return {
    schemaVersion: 1,
    sourceId: "source",
    cursorType: "entry-id",
    cursorValue,
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

function entry(id: string, text: string) {
  return {
    id,
    type: "message",
    message: { id, role: "user", content: [{ type: "text", text }], timestamp: 1_000 },
  };
}

function fixedClock(): Date {
  return new Date("2026-07-10T00:00:00.000Z");
}
