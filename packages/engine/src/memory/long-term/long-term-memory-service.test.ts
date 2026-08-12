import { describe, expect, it } from "vitest";
import { LongTermMemoryService } from "./long-term-memory-service.js";
import { SqliteFtsMemoryIndex } from "./recall/sqlite-fts-index.js";
import type { MemoryRecord } from "./records/memory-record.js";

describe("LongTermMemoryService", () => {
  it("supports explicit remember, FTS5 search, and provenance-preserving forget", async () => {
    const records = new Map<string, MemoryRecord>();
    const store = {
      put: async (record: MemoryRecord) => { records.set(record.id, record); },
      get: async (_scope: MemoryRecord["scope"], id: string) => records.get(id) ?? null,
      list: async () => [...records.values()],
    };
    const index = new SqliteFtsMemoryIndex(":memory:");
    const service = new LongTermMemoryService(store, index, undefined, () => new Date("2026-06-22T00:00:00.000Z"));
    await service.remember({ id: "pnpm", name: "Use pnpm", description: "Package manager preference", content: "Always use pnpm.", type: "user", scope: "user", sourceRefs: ["pi:s1:e1"] });
    expect(service.search({ query: "package manager" }).memories[0]?.record.id).toBe("pnpm");
    await expect(service.forget("user", "pnpm")).resolves.toBe(true);
    expect(service.search({ query: "package manager" }).memories).toEqual([]);
    expect(records.get("pnpm")?.sourceRefs).toEqual(["pi:s1:e1"]);
    index.close();
  });
});
