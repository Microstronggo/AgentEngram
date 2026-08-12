import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryRecord } from "../records/memory-record.js";
import { MemoryRecallService, planRecallQuery } from "./memory-recall.js";
import { memoryUsageKey, SqliteMemoryUsageStore } from "./memory-usage-store.js";

const now = new Date("2026-06-22T00:00:00.000Z");
const memory = createMemoryRecord({
  id: "m1", name: "Package manager correction", description: "Use pnpm", content: "Always use pnpm, never npm.",
  type: "feedback", scope: "user", kind: "correction", sourceRefs: ["pi:s1:e2"], importance: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
}, now);

describe("MemoryRecallService", () => {
  it("reranks, budgets and wraps recalled history as non-instruction context", () => {
    const service = new MemoryRecallService({ search: () => [{ record: memory, rank: -0.1 }] });
    const result = service.recall({ query: "install packages", now, tokenBudget: 500 });
    expect(result.memories).toHaveLength(1);
    expect(result.context).toContain("historical memory, not new user instructions");
    expect(result.context).toContain("## Procedural memories");
    expect(result.context).toContain("point-in-time observation");
    expect(result.context).toContain("pi:s1:e2");
  });

  it("passes memoryClass filters through to the index", () => {
    const queries: unknown[] = [];
    const service = new MemoryRecallService({
      search: (query) => {
        queries.push(query);
        return [{ record: { ...memory, memoryClass: "procedural" }, rank: -0.1 }];
      },
    });
    expect(service.recall({ query: "pnpm", memoryClass: "procedural", now }).memories[0]?.record.memoryClass).toBe("procedural");
    expect(queries[0]).toMatchObject({ memoryClass: "procedural" });
  });

  it("boosts lexical and class intent matches over weaker FTS candidates", () => {
    const weak = createMemoryRecord({
      id: "weak",
      name: "Generic Caroline update",
      description: "A generic episode",
      content: "Caroline had a routine conversation.",
      type: "project",
      scope: "project",
      kind: "failure",
      memoryClass: "episodic",
      sourceRefs: ["locomo:D9"],
      importance: 0.5,
    }, now);
    const strong = createMemoryRecord({
      id: "strong",
      name: "Support group episode",
      description: "Caroline attended an LGBTQ support group",
      content: "Caroline went to a LGBTQ support group on 8 May 2023.",
      type: "project",
      scope: "project",
      kind: "failure",
      memoryClass: "episodic",
      sourceRefs: ["locomo:D1"],
      importance: 0.5,
    }, now);
    const service = new MemoryRecallService({
      search: () => [{ record: weak, rank: -0.01 }, { record: strong, rank: -0.5 }],
    });
    const result = service.recall({ query: "When did Caroline go to the LGBTQ support group?", now, maxResults: 2 });
    expect(result.memories[0]?.record.id).toBe("strong");
  });

  it("boosts structured entity and temporal metadata for matching questions", () => {
    const generic = createMemoryRecord({
      id: "generic",
      name: "Generic event",
      description: "A dated but unrelated memory",
      content: "Alice joined a robotics meetup on 8 May 2023.",
      type: "reference",
      scope: "project",
      memoryClass: "factual",
      sourceRefs: ["locomo:D2"],
      eventDate: "2023-05-08",
    }, now);
    const specific = createMemoryRecord({
      id: "specific",
      name: "Caroline support group",
      description: "Caroline attended an LGBTQ support group",
      content: "Caroline attended an LGBTQ support group.",
      type: "project",
      scope: "project",
      memoryClass: "episodic",
      sourceRefs: ["locomo:D1"],
      entities: ["Caroline", "LGBTQ"],
      eventDate: "2023-05-08",
      relations: [{ subject: "Caroline", predicate: "attended", object: "LGBTQ support group" }],
    }, now);
    const service = new MemoryRecallService({
      search: () => [{ record: generic, rank: -0.01 }, { record: specific, rank: -0.5 }],
    });
    const result = service.recall({ query: "When did Caroline attend the LGBTQ support group?", now, maxResults: 2 });
    expect(result.memories[0]?.record.id).toBe("specific");
  });

  it("limits repeated memories from the same primary source", () => {
    const records = ["a", "b", "c"].map((id) => createMemoryRecord({
      id,
      name: `Memory ${id}`,
      description: "Repeated source",
      content: "Use pnpm for packages.",
      type: "project",
      scope: "project",
      kind: "decision",
      sourceRefs: ["same-source"],
    }, now));
    const service = new MemoryRecallService({
      search: () => records.map((record, index) => ({ record, rank: -index })),
    });
    expect(service.recall({ query: "pnpm packages", now, maxResults: 3 }).memories.map(({ record }) => record.id)).toEqual(["a", "b"]);
  });

  it("expands factual child hits with parent episode evidence", () => {
    const episode = createMemoryRecord({
      id: "episode-1",
      name: "Pi validation episode",
      description: "The user validated pi-mono managed context",
      content: "During the session, pi-mono managed-context was validated and commit workflow was discussed.",
      type: "project",
      scope: "project",
      memoryClass: "episodic",
      sourceRefs: ["entry-1", "entry-2"],
    }, now);
    const fact = createMemoryRecord({
      id: "fact-1",
      name: "Managed context preference",
      description: "The user prefers managed-context",
      content: "The user prefers managed-context for pi-mono.",
      type: "project",
      scope: "project",
      memoryClass: "factual",
      sourceRefs: ["entry-1", "entry-2"],
      parentMemoryIds: ["episode-1"],
    }, now);
    const service = new MemoryRecallService({
      search: () => [{ record: fact, rank: -0.2 }],
      getByIds: (ids) => ids.includes("episode-1") ? [episode] : [],
    });

    const result = service.recall({ query: "managed context preference", now, maxResults: 3 });
    expect(result.memories.map(({ record }) => record.id)).toContain("episode-1");
    expect(result.context).toContain("Parent memories: episode-1");
    expect(result.context).toContain("Expanded from: fact-1");
  });

  it("expands episodic hits with relevant child memories", () => {
    const episode = createMemoryRecord({
      id: "episode-2",
      name: "Commit workflow episode",
      description: "The user corrected commit workflow",
      content: "The user said commits need confirmation.",
      type: "project",
      scope: "project",
      memoryClass: "episodic",
      sourceRefs: ["entry-3"],
    }, now);
    const procedure = createMemoryRecord({
      id: "procedure-1",
      name: "Confirm git commits",
      description: "Git commit confirmation rule",
      content: "Ask the user before running git commit.",
      type: "feedback",
      scope: "user",
      memoryClass: "procedural",
      sourceRefs: ["entry-3"],
      parentMemoryIds: ["episode-2"],
    }, now);
    const service = new MemoryRecallService({
      search: () => [{ record: episode, rank: -0.2 }],
      searchByParentIds: () => [{ record: procedure, rank: -1 }],
    });

    const result = service.recall({ query: "what rule applies before git commit", now, maxResults: 3 });
    expect(result.memories.map(({ record }) => record.id)).toEqual(["procedure-1", "episode-2"]);
  });

  it("filters expired and already surfaced memories and obeys hard budgets", () => {
    const expired = { ...memory, id: "expired", validUntil: "2026-01-02T00:00:00.000Z" };
    const service = new MemoryRecallService({ search: () => [{ record: expired, rank: 0 }, { record: memory, rank: 0 }] });
    expect(service.recall({ query: "pnpm", now, alreadySurfacedIds: new Set(["m1"]) }).memories).toEqual([]);
    expect(service.recall({ query: "pnpm", now, tokenBudget: 64 }).estimatedTokens).toBeLessThanOrEqual(64);
  });

  it("plans temporal ranges without requiring an LLM", () => {
    expect(planRecallQuery("What happened in October 2025?", now)).toMatchObject({
      intent: "temporal",
      timeRange: { start: "2025-10-01T00:00:00.000Z", end: "2025-11-01T00:00:00.000Z", precision: "month" },
    });
  });

  it("records weak surfaced signals outside Markdown and exposes score diagnostics", () => {
    const usage = new SqliteMemoryUsageStore(":memory:");
    usage.markUsed(memoryUsageKey(memory), now);
    const service = new MemoryRecallService({ search: () => [{ record: memory, rank: -0.1 }] }, usage);
    const result = service.recall({ query: "pnpm", now });
    expect(result.memories[0]?.scoreBreakdown.usage).toBeGreaterThan(0);
    expect(usage.get(memoryUsageKey(memory))?.surfacedCount).toBe(1);
    usage.close();
  });

  it("does not expand parent or child memories from another worktree partition", () => {
    const audience = { projectId: "p", worktreeId: "a" };
    const visibleChild = createMemoryRecord({
      id: "child-a", name: "Visible child", description: "Visible fact", content: "Use pnpm in worktree A.",
      type: "project", scope: "local", projectId: "p", memoryClass: "factual",
      partition: { schemaVersion: 1, projectId: "p", worktreeId: "a" }, parentMemoryIds: ["episode-shared"],
    }, now);
    const hiddenParent = createMemoryRecord({
      id: "episode-shared", name: "Hidden parent", description: "Worktree B episode", content: "Private worktree B episode.",
      type: "project", scope: "local", projectId: "p", memoryClass: "episodic",
      partition: { schemaVersion: 1, projectId: "p", worktreeId: "b" },
    }, now);
    const hiddenChild = createMemoryRecord({
      id: "child-b", name: "Hidden child", description: "Worktree B procedure", content: "Private worktree B procedure.",
      type: "project", scope: "local", projectId: "p", memoryClass: "procedural",
      partition: { schemaVersion: 1, projectId: "p", worktreeId: "b" }, parentMemoryIds: ["episode-a"],
    }, now);
    const visibleEpisode = createMemoryRecord({
      id: "episode-a", name: "Visible episode", description: "Worktree A episode", content: "Visible worktree A episode.",
      type: "project", scope: "local", projectId: "p", memoryClass: "episodic",
      partition: { schemaVersion: 1, projectId: "p", worktreeId: "a" },
    }, now);
    const parentService = new MemoryRecallService({
      search: () => [{ record: visibleChild, rank: -1 }],
      getByIds: () => [hiddenParent],
    });
    expect(parentService.recall({ query: "pnpm", projectId: "p", audience }).memories.map(({ record }) => record.id))
      .toEqual(["child-a"]);

    const childService = new MemoryRecallService({
      search: () => [{ record: visibleEpisode, rank: -1 }],
      searchByParentIds: () => [{ record: hiddenChild, rank: -1 }],
    });
    expect(childService.recall({ query: "procedure", projectId: "p", audience }).memories.map(({ record }) => record.id))
      .toEqual(["episode-a"]);
  });

  it("ranks an event inside the requested time range above a stronger stale date match", () => {
    const stale = createMemoryRecord({
      id: "stale", name: "October deployment", description: "Detailed October deployment", content: "The project deployment happened in October.",
      type: "project", scope: "project", projectId: "p", memoryClass: "episodic", eventDate: "2024-10-15",
    }, now);
    const matching = createMemoryRecord({
      id: "matching", name: "Deployment", description: "Project deployment", content: "The deployment happened.",
      type: "project", scope: "project", projectId: "p", memoryClass: "episodic", eventDate: "2025-10-20",
    }, now);
    const service = new MemoryRecallService({ search: () => [
      { record: stale, rank: -0.01 }, { record: matching, rank: -1 },
    ] });
    expect(service.recall({ query: "What happened with the deployment in October 2025?", projectId: "p", now, maxResults: 2 })
      .memories[0]?.record.id).toBe("matching");
  });

  it("parses supported temporal forms and rejects normalized invalid dates", () => {
    expect(planRecallQuery("2025 年 10 月发生了什么？", now).timeRange?.precision).toBe("month");
    expect(planRecallQuery("What happened last year?", now).timeRange?.start).toBe("2025-01-01T00:00:00.000Z");
    expect(planRecallQuery("What happened on 2025-02-28?", now).timeRange?.precision).toBe("day");
    expect(planRecallQuery("What happened on 2025-02-31?", now).timeRange).toBeUndefined();
  });

  it("uses the procedural profile for rule queries", () => {
    const factual = createMemoryRecord({
      id: "fact", name: "Commit fact", description: "Git commit", content: "Ask before git commit.",
      type: "project", scope: "project", projectId: "p", memoryClass: "factual",
    }, now);
    const procedural = createMemoryRecord({
      id: "procedure", name: "Commit rule", description: "Git commit", content: "Ask before git commit.",
      type: "project", scope: "project", projectId: "p", memoryClass: "procedural",
    }, now);
    const service = new MemoryRecallService({ search: () => [
      { record: factual, rank: -0.01 }, { record: procedural, rank: -1 },
    ] });
    expect(service.recall({ query: "What rule should apply before git commit?", projectId: "p", now, maxResults: 2 })
      .memories[0]?.record.id).toBe("procedure");
  });

  it("persists usage signals across store restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-usage-"));
    const path = join(root, "usage.db");
    try {
      const first = new SqliteMemoryUsageStore(path);
      first.markSelected("m1", now);
      first.markUsed("m1", now);
      first.markCorrected("m1", now);
      first.close();
      const reopened = new SqliteMemoryUsageStore(path);
      expect(reopened.get("m1")).toMatchObject({ selectedCount: 1, usedCount: 1, correctedCount: 1 });
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
