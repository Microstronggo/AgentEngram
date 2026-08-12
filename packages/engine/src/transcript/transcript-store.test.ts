import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { TranscriptStore } from "./transcript-store.js";
import type { NormalizedTranscriptEntry } from "./normalized-transcript-entry.js";
import type { RawTranscriptRecord } from "./raw-transcript-record.js";
import { BlobStore } from "../storage/blob-store.js";

describe("TranscriptStore", () => {
  it("appends raw and normalized records and reads append order", async () => {
    const store = new TranscriptStore({ rootDir: await tempDir() });
    await store.append({ raw: raw("r1", "e1"), normalized: normalized("n1", "e1") });
    await store.append({ raw: raw("r2", "e2"), normalized: normalized("n2", "e2") });

    expect((await store.readRaw("s1")).map((record) => record.id)).toEqual(["r1", "r2"]);
    expect((await store.readNormalized("s1")).map((entry) => entry.id)).toEqual(["n1", "n2"]);
  });

  it("reads normalized entries after a per-thread cursor and rejects a missing cursor", async () => {
    const directory = await tempDir();
    const store = new TranscriptStore({ rootDir: directory });
    const makeEntry = (id: string, threadId: string) => ({
      schemaVersion: 1 as const,
      id,
      sessionId: "session-a",
      threadId,
      sourceRef: `agentengram://transcript/session-a/${threadId}/${id}`,
      kind: "message" as const,
      role: "user",
      text: id,
      contentHash: id,
      createdAt: "2026-06-27T00:00:00.000Z",
    });
    await store.appendNormalized("session-a", makeEntry("a1", "thread-a"));
    await store.appendNormalized("session-a", makeEntry("b1", "thread-b"));
    await store.appendNormalized("session-a", makeEntry("a2", "thread-a"));

    await expect(store.readNormalizedAfter({ sessionId: "session-a", threadId: "thread-a", cursor: "a1" }))
      .resolves.toMatchObject([{ id: "a2", threadId: "thread-a" }]);
    await expect(store.readNormalizedAfter({ sessionId: "session-a", threadId: "thread-a", cursor: "missing" }))
      .rejects.toThrow("transcript cursor was not found");
  });

  it("deduplicates by stable record id", async () => {
    const store = new TranscriptStore({ rootDir: await tempDir() });
    await store.append({ raw: raw("r1", "e1"), normalized: normalized("n1", "e1") });
    await store.append({ raw: raw("r1", "e1"), normalized: normalized("n1", "e1") });
    expect(await store.readRaw("s1")).toHaveLength(1);
    expect(await store.readNormalized("s1")).toHaveLength(1);
  });

  it("keeps large content in BlobStore", async () => {
    const store = new TranscriptStore({ rootDir: await tempDir(), largeContentBytes: 16 });
    await store.append({
      raw: { ...raw("r1", "e1"), content: { text: "large ".repeat(20) } },
      normalized: { ...normalized("n1", "e1"), text: "large ".repeat(20) },
    });
    const [storedRaw] = await store.readRaw("s1");
    const [storedNormalized] = await store.readNormalized("s1");
    expect(storedRaw?.blobRef?.algorithm).toBe("sha256");
    expect(storedNormalized?.blobRef?.algorithm).toBe("sha256");
    expect(JSON.stringify(storedRaw?.content)).toContain("omitted");
  });

  it("survives partial trailing JSONL line by returning valid prefix", async () => {
    const rootDir = await tempDir();
    const store = new TranscriptStore({ rootDir });
    await store.append({ raw: raw("r1", "e1") });
    await writeFile(
      join(rootDir, "transcripts", "s1", "raw.jsonl"),
      `${JSON.stringify(raw("r1", "e1"))}\n{"broken":`,
      "utf8",
    );
    expect((await store.readRaw("s1")).map((record) => record.id)).toEqual(["r1"]);
  });

  it("repairs a partial suffix before the next true append", async () => {
    const rootDir = await tempDir();
    const store = new TranscriptStore({ rootDir });
    await store.append({ raw: raw("r1", "e1") });
    await writeFile(join(rootDir, "transcripts", "s1", "raw.jsonl"),
      `${JSON.stringify(raw("r1", "e1"))}\n{\"broken\":`, "utf8");

    await store.append({ raw: raw("r2", "e2") });

    expect((await store.readRaw("s1")).map(({ id }) => id)).toEqual(["r1", "r2"]);
    expect((await store.verify("s1")).valid).toBe(true);
  });

  it("keeps verification read-only and quarantines bytes during explicit repair", async () => {
    const rootDir = await tempDir();
    const store = new TranscriptStore({ rootDir });
    await store.append({ raw: raw("r1", "e1") });
    const path = join(rootDir, "transcripts", "s1", "raw.jsonl");
    const corrupt = `${JSON.stringify(raw("r1", "e1"))}\n{\"secret-tail\":`;
    await writeFile(path, corrupt, "utf8");

    await expect(store.verify("s1")).resolves.toMatchObject({ valid: false, repaired: false });
    expect(await readFile(path, "utf8")).toBe(corrupt);

    const repaired = await store.repair("s1");
    expect(repaired).toMatchObject({ valid: true, repaired: true });
    expect(repaired.quarantinePaths).toHaveLength(1);
    expect(await readFile(repaired.quarantinePaths![0]!, "utf8")).toBe('{"secret-tail":');
    expect((await store.readRaw("s1")).map(({ id }) => id)).toEqual(["r1"]);
  });

  it("serializes concurrent store instances without losing or duplicating rows", async () => {
    const rootDir = await tempDir();
    const first = new TranscriptStore({ rootDir });
    const second = new TranscriptStore({ rootDir });
    await Promise.all(Array.from({ length: 50 }, (_, index) => {
      const store = index % 2 === 0 ? first : second;
      return store.append({
        raw: raw(`r${index}`, `e${index}`),
        normalized: normalized(`n${index}`, `e${index}`),
      });
    }));

    expect(new Set((await first.readRaw("s1")).map(({ id }) => id)).size).toBe(50);
    expect(new Set((await first.readNormalized("s1")).map(({ id }) => id)).size).toBe(50);
    first.close();
    second.close();
  });

  it("purges session rows and only unreferenced project blobs", async () => {
    const rootDir = await tempDir();
    const store = new TranscriptStore({ rootDir, largeContentBytes: 16 });
    await store.appendRaw({ ...raw("r1", "e1"), content: { text: "first ".repeat(30) } });
    await store.appendRaw({
      ...raw("r2", "e2"), frameworkSessionId: "s2", frameworkThreadId: "t2",
      sourceRef: "agentengram://transcript/s2/t2/e2", content: { text: "second ".repeat(30) },
    });
    const first = (await store.readRaw("s1"))[0]!.blobRef!;
    const second = (await store.readRaw("s2"))[0]!.blobRef!;

    await expect(store.purgeSession("s1")).resolves.toEqual({ removedBlobs: 1 });
    expect(store.listSessions()).toEqual(["s2"]);
    const blobs = new BlobStore(join(rootDir, "blobs"));
    await expect(blobs.get(first)).rejects.toThrow();
    await expect(blobs.get(second)).resolves.toBeDefined();
  });

  it("keeps the JSONL inode while appending a large delta batch", async () => {
    const rootDir = await tempDir();
    const store = new TranscriptStore({ rootDir });
    const path = join(rootDir, "transcripts", "s1", "raw.jsonl");
    await store.append({ raw: raw("initial", "initial") });
    const before = await stat(path);
    await store.appendMany(Array.from({ length: 1_000 }, (_, index) => ({ raw: raw(`bulk-${index}`, `bulk-${index}`) })));
    const after = await stat(path);

    expect(after.ino).toBe(before.ino);
    expect((await store.readRaw("s1"))).toHaveLength(1_001);
  });

  it("discovers and indexes pre-manifest transcript sessions", async () => {
    const rootDir = await tempDir();
    await writeFile(join(rootDir, "legacy-placeholder"), "legacy", "utf8");
    const directory = join(rootDir, "transcripts", "s1");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "raw.jsonl"), `${JSON.stringify(raw("legacy", "legacy"))}\n`, "utf8");
    const store = new TranscriptStore({ rootDir });

    expect(await store.discoverSessions()).toEqual(["s1"]);
    await expect(store.verify("s1")).resolves.toMatchObject({ valid: true, rawRecords: 1 });
    expect(store.listSessions()).toEqual([]);
    await expect(store.repair("s1")).resolves.toMatchObject({ valid: true, repaired: false });
    expect(store.listSessions()).toEqual(["s1"]);
  });
});

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentengram-transcript-"));
}

function raw(id: string, entryId: string): RawTranscriptRecord {
  return {
    schemaVersion: 1,
    id,
    framework: "pi-mono",
    frameworkSessionId: "s1",
    frameworkThreadId: "t1",
    frameworkEntryId: entryId,
    eventType: "message.created",
    role: "user",
    timestamp: "2026-06-24T00:00:00.000Z",
    content: { text: entryId },
    contentHash: `hash-${entryId}`,
    sourceRef: `agentengram://transcript/s1/t1/${entryId}`,
    frameworkSourceRef: `pi://session/s1/thread/t1/entry/${entryId}`,
  };
}

function normalized(id: string, entryId: string): NormalizedTranscriptEntry {
  return {
    schemaVersion: 1,
    id,
    sessionId: "s1",
    threadId: "t1",
    sourceRef: `agentengram://transcript/s1/t1/${entryId}`,
    frameworkSourceRef: `pi://session/s1/thread/t1/entry/${entryId}`,
    kind: "message",
    role: "user",
    text: entryId,
    contentHash: `hash-${entryId}`,
    createdAt: "2026-06-24T00:00:00.000Z",
  };
}
