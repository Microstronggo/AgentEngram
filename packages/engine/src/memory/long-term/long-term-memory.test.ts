import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRecord } from "./records/memory-record.js";
import { parseMemoryMarkdown, serializeMemoryMarkdown } from "./records/markdown-codec.js";
import { MarkdownMemoryStore } from "./records/markdown-store.js";
import { SqliteFtsMemoryIndex } from "./recall/sqlite-fts-index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function exampleMemory() {
  return createMemoryRecord(
    {
      id: "pi-context-policy",
      name: "Pi context policy",
      description: "AgentEngram owns the projected context for Pi",
      type: "project",
      scope: "project",
      kind: "decision",
      projectId: "agentengram--abc123",
      content: "Keep the canonical transcript and project a bounded model context.",
      sourceRefs: ["pi:session:entry"],
      importance: 0.9,
      memoryClass: "factual",
      entities: ["pi-mono", "AgentEngram"],
      eventDate: "2026-06-22",
      relativeDate: "today",
      relations: [{ subject: "AgentEngram", predicate: "owns", object: "projected context" }],
      parentMemoryIds: ["episode-1"],
    },
    new Date("2026-06-22T04:00:00.000Z"),
  );
}

describe("long-term memory", () => {
  it("round-trips the long-term-memory Markdown schema", () => {
    const record = exampleMemory();
    expect(parseMemoryMarkdown(serializeMemoryMarkdown(record))).toEqual(record);
    expect(serializeMemoryMarkdown(record)).toContain("memory_class: factual");
    expect(serializeMemoryMarkdown(record)).toContain("entities:");
    expect(serializeMemoryMarkdown(record)).toContain("relations_json:");
    expect(serializeMemoryMarkdown(record)).toContain("parent_memory_ids:");
  });

  it("reads legacy markdown that does not contain memory_class", () => {
    const record = exampleMemory();
    const legacy = serializeMemoryMarkdown(record).replace(/^memory_class: factual\n/m, "");
    const parsed = parseMemoryMarkdown(legacy);
    expect(parsed).toMatchObject({
      id: record.id,
      kind: "decision",
    });
    expect(parsed.memoryClass).toBe("factual");
  });

  it("stores project memories atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-store-"));
    temporaryDirectories.push(root);
    const store = new MarkdownMemoryStore(root);
    const record = exampleMemory();
    await store.put(record);
    await expect(store.get("project", record.id, record.projectId)).resolves.toEqual(record);
    await expect(store.list("project", record.projectId)).resolves.toEqual([record]);
    const path = join(root, "projects", record.projectId!, "project", `${record.id}.md`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects frontmatter that escapes its directory scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-store-"));
    temporaryDirectories.push(root);
    const record = exampleMemory();
    const { projectId: _projectId, ...globalRecord } = record;
    const directory = join(root, "projects", record.projectId!, "project");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${record.id}.md`),
      serializeMemoryMarkdown({ ...globalRecord, scope: "user" }),
      "utf8",
    );
    const store = new MarkdownMemoryStore(root);
    await expect(store.get("project", record.id, record.projectId)).rejects.toThrow("scope");
  });

  it("retrieves memories with FTS5 and scope filters", () => {
    const index = new SqliteFtsMemoryIndex(":memory:");
    const record = exampleMemory();
    index.upsert(record);
    expect(index.search({ text: "projected context", scope: "project", projectId: record.projectId! })[0]?.record.id).toBe(record.id);
    expect(index.search({ text: "owns", scope: "project", projectId: record.projectId! })[0]?.record.id).toBe(record.id);
    expect(index.search({ text: "factual", memoryClass: "factual", scope: "project", projectId: record.projectId! })[0]?.record.id).toBe(record.id);
    expect(index.search({ text: "projected context", memoryClass: "procedural", scope: "project", projectId: record.projectId! })).toEqual([]);
    expect(index.getByIds(["pi-context-policy"], { projectId: record.projectId! })[0]?.id).toBe(record.id);
    expect(index.search({ text: "projected context", scope: "user" })).toEqual([]);
    index.close();
  });

  it("finds child memories by parent ids from the FTS payload", () => {
    const index = new SqliteFtsMemoryIndex(":memory:");
    const parent = { ...exampleMemory(), id: "episode-parent", memoryClass: "episodic" as const, parentMemoryIds: undefined };
    const child = createMemoryRecord({
      ...exampleMemory(),
      id: "child-fact",
      memoryClass: "factual",
      parentMemoryIds: ["episode-parent"],
      content: "The user prefers managed-context for pi-mono.",
    });
    index.upsert(parent);
    index.upsert(child);
    expect(index.searchByParentIds(["episode-parent"], { text: "managed context", projectId: child.projectId! })[0]?.record.id)
      .toBe("child-fact");
    index.close();
  });

  it("uses prefix matching for simple lexical variants", () => {
    const index = new SqliteFtsMemoryIndex(":memory:");
    const record = createMemoryRecord({
      ...exampleMemory(),
      id: "painting",
      content: "Melanie painted a sunrise over the lake.",
    });
    index.upsert(record);
    expect(index.search({ text: "paint sunrise", scope: "project", projectId: record.projectId! })[0]?.record.id).toBe("painting");
    expect(index.search({ text: "lake-sunrise", scope: "project", projectId: record.projectId! })[0]?.record.id).toBe("painting");
    index.close();
  });

  it("prefers content-bearing query tokens over repeated proper names", () => {
    const index = new SqliteFtsMemoryIndex(":memory:");
    const base = exampleMemory();
    index.upsert(createMemoryRecord({
      ...base,
      id: "generic-caroline",
      content: "Caroline had a routine conversation with Melanie about the week.",
      sourceRefs: ["locomo:D1"],
    }));
    index.upsert(createMemoryRecord({
      ...base,
      id: "specific-necklace",
      content: "Caroline said her necklace was from her grandmother in Sweden.",
      sourceRefs: ["locomo:D2"],
    }));
    expect(index.search({ text: "What country is Caroline's necklace from?", scope: "project", projectId: base.projectId! })[0]?.record.id)
      .toBe("specific-necklace");
    index.close();
  });

  it("does not recall superseded memories", () => {
    const index = new SqliteFtsMemoryIndex(":memory:");
    index.upsert({ ...exampleMemory(), status: "superseded" });
    expect(index.search({ text: "projected context", projectId: exampleMemory().projectId! })).toEqual([]);
    index.close();
  });

  it("isolates identical memory ids between projects", () => {
    const index = new SqliteFtsMemoryIndex(":memory:");
    index.upsert({ ...exampleMemory(), projectId: "project-a", content: "alpha boundary" });
    index.upsert({ ...exampleMemory(), projectId: "project-b", content: "beta boundary" });
    expect(index.search({ text: "boundary", projectId: "project-a" }).map(({ record }) => record.content))
      .toEqual(["alpha boundary"]);
    expect(index.search({ text: "boundary", projectId: "project-b" }).map(({ record }) => record.content))
      .toEqual(["beta boundary"]);
    expect(index.search({ text: "boundary" })).toEqual([]);
    index.close();
  });

  it("keeps identical local ids in different worktrees as separate Markdown facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-partition-store-"));
    temporaryDirectories.push(root);
    const store = new MarkdownMemoryStore(root);
    const local = (worktreeId: string, content: string) => createMemoryRecord({
      id: "same-local-id", name: "Local state", description: "Worktree-local state", content,
      type: "project", scope: "local", projectId: "project-a",
      partition: { schemaVersion: 1, projectId: "project-a", worktreeId },
    });
    await store.put(local("worktree-a", "Alpha checkout state"));
    await store.put(local("worktree-b", "Beta checkout state"));
    expect(await store.list("local", "project-a")).toHaveLength(2);
    await expect(store.get("local", "same-local-id", "project-a")).rejects.toThrow("ambiguous across partitions");
    await expect(store.get("local", "same-local-id", "project-a", {
      schemaVersion: 1, projectId: "project-a", worktreeId: "worktree-b",
    })).resolves.toMatchObject({ content: "Beta checkout state" });
  });

  it("filters invisible partitions before applying the SQL candidate limit", () => {
    const index = new SqliteFtsMemoryIndex(":memory:");
    for (let value = 0; value < 8; value++) {
      index.upsert(createMemoryRecord({
        id: `hidden-${value}`, name: "Shared search", description: "Hidden worktree", content: "shared partition token",
        type: "project", scope: "local", projectId: "p",
        partition: { schemaVersion: 1, projectId: "p", worktreeId: "hidden" },
      }));
    }
    index.upsert(createMemoryRecord({
      id: "visible", name: "Shared search", description: "Visible worktree", content: "shared partition token",
      type: "project", scope: "local", projectId: "p",
      partition: { schemaVersion: 1, projectId: "p", worktreeId: "visible" },
    }));
    expect(index.search({
      text: "shared partition token", projectId: "p", scope: "local", limit: 1,
      audience: { projectId: "p", worktreeId: "visible" },
    }).map(({ record }) => record.id)).toEqual(["visible"]);
    index.close();
  });
});
