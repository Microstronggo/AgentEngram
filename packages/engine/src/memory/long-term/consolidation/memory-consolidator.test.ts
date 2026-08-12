import { describe, expect, it, vi } from "vitest";
import { createMemoryRecord, type MemoryRecord } from "../records/memory-record.js";
import { DreamCoordinator } from "./dream-coordinator.js";
import { MemoryConsolidator } from "./memory-consolidator.js";

const now = new Date("2026-06-22T00:00:00.000Z");
const make = (id: string, content: string): MemoryRecord => createMemoryRecord({
  id, name: id, description: id, content, type: "project", scope: "project", projectId: "p", sourceRefs: [`s:${id}`],
  updatedAt: "2025-01-01T00:00:00.000Z",
}, now);

describe("MemoryConsolidator", () => {
  it("merges duplicates, resolves conflicts and archives expired records without losing provenance", async () => {
    const records = [make("a", "same"), make("b", "same"), { ...make("old", "stale"), validUntil: "2026-01-01T00:00:00.000Z" }];
    const writes = new Map<string, MemoryRecord>();
    const store = { list: async () => records, put: async (record: MemoryRecord) => { writes.set(record.id, record); } };
    const report = await new MemoryConsolidator(store).consolidate({ scope: "project", projectId: "p", now });
    expect(report).toMatchObject({ merged: 1, expired: 1 });
    expect([...writes.values()].find(record => record.status === "active")?.sourceRefs.sort()).toEqual(["s:a", "s:b"]);
    expect(writes.get("old")?.status).toBe("archived");
  });

  it("uses explicit semantic conflict decisions", async () => {
    const records = [make("npm", "Use npm"), make("pnpm", "Use pnpm")];
    const writes = new Map<string, MemoryRecord>();
    const consolidator = new MemoryConsolidator(
      { list: async () => records, put: async record => { writes.set(record.id, record); } },
      { compare: async () => ({ kind: "conflict", prefer: "right" }) },
    );
    expect(await consolidator.consolidate({ scope: "project", projectId: "p", now })).toMatchObject({ corrected: 1 });
    expect(writes.get("npm")?.status).toBe("superseded");
    expect(writes.get("pnpm")?.supersedes).toBe("npm");
  });

  it("does not compare records from different memory classes", async () => {
    const records = [
      { ...make("fact", "Use pnpm."), memoryClass: "factual" as const, kind: "decision" as const },
      { ...make("episode", "Use pnpm."), memoryClass: "episodic" as const, kind: "failure" as const },
    ];
    const writes = new Map<string, MemoryRecord>();
    const resolver = { compare: vi.fn(async () => ({ kind: "duplicate" as const })) };
    const report = await new MemoryConsolidator(
      { list: async () => records, put: async record => { writes.set(record.id, record); } },
      resolver,
    ).consolidate({ scope: "project", projectId: "p", now });
    expect(report.merged).toBe(0);
    expect(writes.size).toBe(0);
    expect(resolver.compare).not.toHaveBeenCalled();
  });
});

describe("DreamCoordinator", () => {
  it("applies time/session/lock gates and records only successful runs", async () => {
    const recordSuccess = vi.fn();
    const release = vi.fn(async () => undefined);
    const coordinator = new DreamCoordinator({
      consolidator: { consolidate: vi.fn(async () => ({ scanned: 0, merged: 0, corrected: 0, expired: 0, aged: 0, changedIds: [] })) } as unknown as MemoryConsolidator,
      lock: { tryAcquire: async () => release }, readState: async () => ({ lastConsolidatedAt: 0, sessionsTouchedSince: 5 }),
      recordSuccess, clock: () => now,
    });
    await expect(coordinator.run({ scope: "user" })).resolves.toMatchObject({ status: "completed" });
    expect(recordSuccess).toHaveBeenCalledWith(now.getTime());
    expect(release).toHaveBeenCalledOnce();
  });
});
