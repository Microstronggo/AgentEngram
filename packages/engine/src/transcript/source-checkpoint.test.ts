import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeSourceCheckpoint,
  encodeSourceCheckpoint,
  FileSourceCheckpointRepository,
  type SourceCheckpoint,
} from "./source-checkpoint.js";

const checkpoint: SourceCheckpoint = {
  schemaVersion: 1,
  sourceId: "codex:/tmp/rollout.jsonl",
  sourceVersion: "device:1:inode:42",
  cursorType: "byte-offset",
  cursorValue: "8192",
  partialTail: "eyJ0eXBlIjo=",
  parserState: { currentTurnId: "turn-2", lineNumber: 14 },
  updatedAt: "2026-07-10T08:00:00.000Z",
};

describe("SourceCheckpoint", () => {
  it("round-trips source cursor and parser continuity metadata", () => {
    expect(decodeSourceCheckpoint(encodeSourceCheckpoint(checkpoint))).toEqual(checkpoint);
  });

  it("atomically replaces one source while keeping other sources isolated", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agentengram-source-checkpoint-"));
    const repository = new FileSourceCheckpointRepository(rootDir);
    await repository.save(checkpoint);
    await repository.save({ ...checkpoint, cursorValue: "12288", partialTail: "", updatedAt: "2026-07-10T08:01:00.000Z" });
    await repository.save({ ...checkpoint, sourceId: "pi:session-a", cursorType: "entry-id", cursorValue: "entry-7" });

    await expect(repository.load(checkpoint.sourceId)).resolves.toMatchObject({ cursorValue: "12288", partialTail: "" });
    await expect(repository.load("pi:session-a")).resolves.toMatchObject({ cursorValue: "entry-7" });
    expect((await readdir(rootDir)).every((name) => name.endsWith(".json"))).toBe(true);

    await repository.remove(checkpoint.sourceId);
    await expect(repository.load(checkpoint.sourceId)).resolves.toBeUndefined();
    await expect(repository.load("pi:session-a")).resolves.toBeDefined();
  });

  it("fails visibly when a persisted checkpoint is malformed", async () => {
    expect(() => decodeSourceCheckpoint('{"schemaVersion":2}')).toThrow("schema version");
    expect(() => encodeSourceCheckpoint({ ...checkpoint, parserState: { lineNumber: Number.NaN } }))
      .toThrow("parserState");

    const rootDir = await mkdtemp(join(tmpdir(), "agentengram-source-checkpoint-malformed-"));
    const repository = new FileSourceCheckpointRepository(rootDir);
    await repository.save(checkpoint);
    const [path] = await readdir(rootDir);
    await writeFile(join(rootDir, path!), "not-json", "utf8");
    await expect(repository.load(checkpoint.sourceId)).rejects.toThrow("not valid JSON");
  });

  it("serializes concurrent writers and refuses a comparable cursor rollback", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agentengram-source-checkpoint-order-"));
    const repository = new FileSourceCheckpointRepository(rootDir);
    await repository.save(checkpoint);
    await expect(repository.save({ ...checkpoint, cursorValue: "4096", updatedAt: "2026-07-10T08:02:00.000Z" }))
      .rejects.toThrow("cannot regress");
    await expect(repository.load(checkpoint.sourceId)).resolves.toMatchObject({ cursorValue: "8192" });

    // File replacement deliberately permits a new source version to restart at zero.
    await repository.save({
      ...checkpoint,
      sourceVersion: "device:1:inode:99",
      cursorValue: "0",
      updatedAt: "2026-07-10T08:03:00.000Z",
    });
    await expect(repository.load(checkpoint.sourceId)).resolves.toMatchObject({
      sourceVersion: "device:1:inode:99",
      cursorValue: "0",
    });

    await repository.save({
      ...checkpoint,
      sourceVersion: "device:1:inode:99",
      cursorValue: "500",
      updatedAt: "2026-07-10T08:03:30.000Z",
    });
    await repository.save({
      ...checkpoint,
      sourceVersion: "device:1:inode:99",
      cursorValue: "0",
      parserState: { sourceReset: true },
      updatedAt: "2026-07-10T08:04:00.000Z",
    });
  });
});
