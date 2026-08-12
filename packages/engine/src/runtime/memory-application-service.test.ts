import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LongTermMemoryService, MarkdownMemoryStore, SqliteFtsMemoryIndex, type MemoryRecord } from "../memory/index.js";
import { MemoryApplicationService } from "./memory-application-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("MemoryApplicationService", () => {
  it("keeps Markdown and FTS5 consistent across remember, search and forget", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-app-")); roots.push(root);
    await mkdir(join(root, "indexes"), { recursive: true });
    const index = new SqliteFtsMemoryIndex(join(root, "indexes", "memory.db"));
    const service = new MemoryApplicationService(new MarkdownMemoryStore(root), index);
    const record = await service.remember({
      id: "context-policy", name: "Context policy", description: "Pi context ownership",
      content: "Keep canonical transcript and project a bounded context", type: "project", scope: "project",
      projectId: "project-1", sourceRefs: ["session:entry"],
    });
    expect(service.search({ text: "bounded context", projectId: "project-1" })[0]?.record.id).toBe(record.id);
    await expect(service.read("project", record.id, "project-1")).resolves.toEqual(record);
    await expect(service.forget("project", record.id, "project-1")).resolves.toBe(true);
    expect(service.search({ text: "bounded context", projectId: "project-1" })).toEqual([]);
    index.close();
  });

  it("refuses to persist secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-app-")); roots.push(root);
    const index = new SqliteFtsMemoryIndex(":memory:");
    const service = new MemoryApplicationService(new MarkdownMemoryStore(root), index);
    await expect(service.remember({
      name: "Credential", description: "Do not save", content: "api_key=abcdefghijklmnop",
      type: "user", scope: "user",
    })).rejects.toThrow("secret detected");
    index.close();
  });

  it("deduplicates idempotent retries and protects updates with revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-app-")); roots.push(root);
    const index = new SqliteFtsMemoryIndex(":memory:");
    const service = new MemoryApplicationService(new MarkdownMemoryStore(root), index);
    const input = {
      name: "Commit policy", description: "Confirmation rule", content: "Ask before every git commit.",
      type: "project" as const, scope: "project" as const, projectId: "project-1",
      sourceRefs: ["pi:entry-1"], idempotencyKey: "tool-call-1",
    };
    const first = await service.write(input);
    const retry = await service.write(input);
    expect(first.action).toBe("created");
    expect(retry).toMatchObject({ action: "duplicate", record: { id: first.record.id } });

    const updated = await service.update({
      ...input, targetMemoryId: first.record.id, expectedRevision: 1,
      content: "Ask the user before every git commit.", idempotencyKey: "tool-call-2",
    });
    expect(updated).toMatchObject({ action: "updated", record: { revision: 2 } });
    await expect(service.update({
      ...input, targetMemoryId: first.record.id, expectedRevision: 1,
      content: "Never commit automatically.", idempotencyKey: "tool-call-3",
    })).resolves.toMatchObject({ action: "conflict", record: { revision: 2 } });
    index.close();
  });

  it("creates a correction and retains the superseded fact", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-app-")); roots.push(root);
    const index = new SqliteFtsMemoryIndex(":memory:");
    const service = new MemoryApplicationService(new MarkdownMemoryStore(root), index);
    const old = await service.remember({
      id: "package-manager", name: "Package manager", description: "Old preference", content: "Use npm.",
      type: "user", scope: "user", sourceRefs: ["pi:entry-1"], assertedBy: "user",
    });
    const result = await service.correct({
      targetMemoryId: old.id, name: "Package manager correction", description: "Corrected preference",
      content: "Use pnpm, not npm.", type: "feedback", scope: "user", sourceRefs: ["pi:entry-2"],
    });
    expect(result).toMatchObject({ action: "superseded", record: { supersedes: old.id, epistemicStatus: "corrected" } });
    await expect(service.read("user", old.id)).resolves.toMatchObject({ status: "superseded" });
    index.close();
  });

  it("reads and forgets one local record when ids collide across worktrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-app-")); roots.push(root);
    const index = new SqliteFtsMemoryIndex(":memory:");
    const service = new MemoryApplicationService(new MarkdownMemoryStore(root), index);
    const partitionA = { schemaVersion: 1 as const, projectId: "p", worktreeId: "a" };
    const partitionB = { schemaVersion: 1 as const, projectId: "p", worktreeId: "b" };
    const base = { id: "local-rule", name: "Local rule", description: "Checkout-specific rule", type: "project" as const, scope: "local" as const, projectId: "p" };
    await service.remember({ ...base, partition: partitionA, content: "Alpha worktree rule." });
    await service.remember({ ...base, partition: partitionB, content: "Beta worktree rule." });

    await expect(service.read("local", base.id, "p")).rejects.toThrow("ambiguous across partitions");
    await expect(service.read("local", base.id, "p", partitionB)).resolves.toMatchObject({ content: "Beta worktree rule." });
    await expect(service.forget("local", base.id, "p", partitionA)).resolves.toBe(true);
    expect(service.search({ text: "worktree rule", projectId: "p", scope: "local", audience: { projectId: "p", worktreeId: "a" } })).toEqual([]);
    expect(service.search({ text: "worktree rule", projectId: "p", scope: "local", audience: { projectId: "p", worktreeId: "b" } })[0]?.record.content)
      .toBe("Beta worktree rule.");
    index.close();
  });

  it("serializes optimistic updates across two application instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-app-")); roots.push(root);
    const store = new MarkdownMemoryStore(root);
    const index = new SqliteFtsMemoryIndex(":memory:");
    const firstService = new MemoryApplicationService(store, index);
    const secondService = new MemoryApplicationService(new MarkdownMemoryStore(root), index);
    const original = await firstService.remember({
      id: "shared", name: "Shared rule", description: "Concurrent rule", content: "Initial value.",
      type: "project", scope: "project", projectId: "p",
    });
    const command = { name: "Shared rule", description: "Concurrent rule", type: "project" as const, scope: "project" as const,
      projectId: "p", targetMemoryId: original.id, expectedRevision: 1 };
    const results = await Promise.all([
      firstService.update({ ...command, content: "First update." }),
      secondService.update({ ...command, content: "Second update." }),
    ]);
    expect(results.map(({ action }) => action).sort()).toEqual(["conflict", "updated"]);
    await expect(firstService.read("project", original.id, "p")).resolves.toMatchObject({ revision: 2 });
    index.close();
  });

  it("rolls back a correction when the new FTS projection fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-app-")); roots.push(root);
    const store = new MarkdownMemoryStore(root);
    const index = new FailingIndex();
    const service = new MemoryApplicationService(store, index);
    const original = await service.remember({
      id: "preference", name: "Package manager", description: "Original", content: "Use npm.",
      type: "user", scope: "user",
    });
    index.failOnCall = index.calls + 2;
    await expect(service.correct({
      targetMemoryId: original.id, name: "Package manager", description: "Correction", content: "Use pnpm.",
      type: "feedback", scope: "user",
    })).rejects.toThrow("injected FTS failure");
    await expect(service.read("user", original.id)).resolves.toMatchObject({ status: "active", content: "Use npm." });
    expect(await store.list("user")).toHaveLength(1);
    expect(service.search({ text: "npm", scope: "user" })[0]?.record.id).toBe(original.id);
    index.close();
  });

  it("rebuilds FTS after Markdown commits but projection update fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-app-")); roots.push(root);
    const store = new MarkdownMemoryStore(root);
    const index = new FailingIndex();
    const service = new MemoryApplicationService(store, index);
    index.failOnCall = 1;
    await expect(service.remember({
      id: "recoverable", name: "Recoverable", description: "Projection recovery", content: "Markdown remains authoritative.",
      type: "project", scope: "project", projectId: "p",
    })).rejects.toThrow("injected FTS failure");
    expect((await store.get("project", "recoverable", "p"))?.content).toContain("authoritative");
    index.failOnCall = undefined;
    await new LongTermMemoryService(store, index).rebuildIndex([{ scope: "project", projectId: "p" }]);
    expect(index.search({ text: "authoritative", projectId: "p" })[0]?.record.id).toBe("recoverable");
    index.close();
  });

  it("separates exact duplicates by partition and rejects identity mismatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-app-")); roots.push(root);
    const index = new SqliteFtsMemoryIndex(":memory:");
    const service = new MemoryApplicationService(new MarkdownMemoryStore(root), index);
    const base = { name: "Rule", description: "Same content", content: "Keep this local rule.", type: "project" as const,
      scope: "local" as const, projectId: "p" };
    const first = await service.write({ ...base, id: "a", partition: { schemaVersion: 1, projectId: "p", worktreeId: "a" } });
    const second = await service.write({ ...base, id: "b", partition: { schemaVersion: 1, projectId: "p", worktreeId: "b" } });
    expect(first.action).toBe("created");
    expect(second.action).toBe("created");
    await expect(service.write({
      ...base, partition: { schemaVersion: 1, projectId: "other", worktreeId: "a" },
    })).rejects.toThrow("projectId does not match");
    index.close();
  });
});

class FailingIndex extends SqliteFtsMemoryIndex {
  calls = 0;
  failOnCall: number | undefined;

  constructor() { super(":memory:"); }

  override upsert(record: MemoryRecord): void {
    this.calls++;
    if (this.calls === this.failOnCall) throw new Error("injected FTS failure");
    super.upsert(record);
  }
}
