import { describe, expect, it, vi } from "vitest";
import { FormationCellBuilder } from "./formation-cell.js";
import { CellMemoryFormationPipeline } from "./cell-memory-formation.js";
import { MemoryFormationPipeline, type MemoryCandidate } from "./memory-formation.js";

const candidate: MemoryCandidate = {
  name: "Use pnpm",
  description: "The user corrected the package manager choice",
  type: "feedback",
  scope: "user",
  kind: "correction",
  memoryClass: "procedural",
  content: "Use pnpm rather than npm for this user's projects.",
};

describe("MemoryFormationPipeline", () => {
  it("persists a significant, safe, non-duplicate candidate with provenance", async () => {
    const put = vi.fn();
    const pipeline = new MemoryFormationPipeline({
      extractor: { extract: async () => [candidate] },
      evaluator: { evaluate: async () => ({ save: true, importance: 0.9 }) },
      scanner: { scan: async () => ({ allowed: true }) },
      duplicates: { resolve: async () => ({ action: "write" }) },
      writer: { put },
      idFactory: () => "memory-1",
      clock: () => new Date("2026-06-22T04:00:00.000Z"),
    });

    const result = await pipeline.form({ text: "No, use pnpm", sourceRefs: ["pi:s1:e2"] });
    expect(result[0]).toMatchObject({ status: "written", record: { id: "memory-1", memoryClass: "procedural", sourceRefs: ["pi:s1:e2"] } });
    expect(put).toHaveBeenCalledOnce();
  });

  it("does not write unsafe candidates", async () => {
    const put = vi.fn();
    const pipeline = new MemoryFormationPipeline({
      extractor: { extract: async () => [candidate] },
      evaluator: { evaluate: async () => ({ save: true, importance: 1 }) },
      scanner: { scan: async () => ({ allowed: false, reason: "secret" }) },
      duplicates: { resolve: async () => ({ action: "write" }) },
      writer: { put },
    });

    await expect(pipeline.form({ text: "token", sourceRefs: [] })).resolves.toEqual([
      { status: "skipped", reason: "unsafe", detail: "secret" },
    ]);
    expect(put).not.toHaveBeenCalled();
  });

  it("atomically marks corrected memory superseded while preserving evidence", async () => {
    const put = vi.fn();
    const existing = {
      id: "old", name: "Use npm", description: "old", content: "npm", tags: [], type: "feedback" as const,
      scope: "user" as const, sourceRefs: ["old-source"], status: "active" as const, schemaVersion: 1 as const,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const pipeline = new MemoryFormationPipeline({
      extractor: { extract: async () => [candidate] }, evaluator: { evaluate: async () => ({ save: true, importance: 1 }) },
      scanner: { scan: async () => ({ allowed: true }) }, duplicates: { resolve: async () => ({ action: "supersede", existingId: "old", existingRecord: existing }) },
      writer: { put }, allowScope: memory => memory.scope === "user", idFactory: () => "new", clock: () => new Date("2026-06-22T00:00:00.000Z"),
    });
    const result = await pipeline.form({ text: "use pnpm", sourceRefs: ["new-source"] });
    expect(result[0]).toMatchObject({ status: "written", record: { supersedes: "old" }, supersededRecord: { id: "old", status: "superseded" } });
    expect(put).toHaveBeenCalledTimes(2);
  });
});

describe("CellMemoryFormationPipeline", () => {
  it("writes an episode first and derives child memories with parentMemoryIds", async () => {
    const writes: unknown[] = [];
    let id = 0;
    const cell = new FormationCellBuilder({ idFactory: () => "cell-1" }).fromEpisode({
      text: "The user asked to validate pi-mono managed-context and required git commits to be confirmed first.",
      sourceEntryIds: ["entry-1", "entry-2"],
      projectId: "agentengram",
    });
    const pipeline = new CellMemoryFormationPipeline({
      episodeExtractor: {
        extract: async () => [{
          name: "Pi managed-context validation episode",
          description: "A completed validation discussion",
          type: "project",
          scope: "project",
          content: "The session validated pi-mono managed-context and captured commit confirmation requirements.",
          memoryClass: "episodic",
          kind: "failure",
          projectId: "agentengram",
        }],
      },
      derivedExtractor: {
        extract: async ({ episode }) => [{
          name: "Confirm before git commit",
          description: "Commit workflow rule derived from the episode",
          type: "feedback",
          scope: "user",
          content: "The user requires confirmation before git commit.",
          memoryClass: "procedural",
          kind: "convention",
          parentMemoryIds: [episode.id],
        }],
      },
      evaluator: { evaluate: async () => ({ save: true, importance: 0.9 }) },
      scanner: { scan: async () => ({ allowed: true }) },
      duplicates: { resolve: async () => ({ action: "write" }) },
      writer: { put: async (record) => { writes.push(record); } },
      idFactory: () => `memory-${++id}`,
      clock: () => new Date("2026-06-26T00:00:00.000Z"),
    });

    const result = await pipeline.formCell(cell);
    expect(result).toHaveLength(2);
    expect(writes).toMatchObject([
      { id: "memory-1", memoryClass: "episodic", sourceRefs: ["entry-1", "entry-2"] },
      { id: "memory-2", memoryClass: "procedural", parentMemoryIds: ["memory-1"], sourceRefs: ["entry-1", "entry-2"] },
    ]);
  });
});
