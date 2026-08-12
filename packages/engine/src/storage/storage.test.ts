import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCheckpointPointer,
  readCheckpoint,
  validateCheckpointPointer,
  validateCheckpointProjectionHead,
  writeCheckpointAtomic,
  type ProjectionCheckpoint,
} from "./checkpoint/index.js";
import { ProjectionLog, readProjectionLog } from "./projection-log/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agentengram-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ProjectionLog", () => {
  it("appends an fsynced hash chain and restores it", async () => {
    const path = join(await temporaryDirectory(), "projection.jsonl");
    const log = new ProjectionLog(path);
    const [first, second] = await Promise.all([
      log.append("collapse.staged", { span: "a" }, "2026-06-22T00:00:00.000Z"),
      log.append("collapse.committed", { span: "a" }, "2026-06-22T00:00:01.000Z"),
    ]);
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(second.previousHash).toBe(first.hash);
    const restored = await log.read();
    expect(restored.status).toBe("ok");
    expect(restored.records).toHaveLength(2);
  });

  it("serializes appends across independently constructed log handles", async () => {
    const path = join(await temporaryDirectory(), "projection.jsonl");
    await Promise.all([
      new ProjectionLog(path).append("first", { value: 1 }),
      new ProjectionLog(path).append("second", { value: 2 }),
    ]);

    const restored = await new ProjectionLog(path).read();
    expect(restored.status).toBe("ok");
    expect(restored.records.map(({ seq }) => seq)).toEqual([1, 2]);
  });

  it("returns the valid prefix and degrades on corruption", async () => {
    const path = join(await temporaryDirectory(), "projection.jsonl");
    const log = new ProjectionLog(path);
    await log.append("snip", { ids: ["a"] });
    await writeFile(path, `${await readFile(path, "utf8")}not-json\n`, "utf8");
    const restored = await readProjectionLog(path);
    expect(restored).toMatchObject({ status: "corrupt", line: 2 });
    expect(restored.records).toHaveLength(1);
    await expect(log.append("compact", {})).rejects.toThrow("Cannot append to corrupt projection log");
  });
});

describe("checkpoint storage", () => {
  function checkpoint(): ProjectionCheckpoint {
    return {
      schemaVersion: 1,
      projectId: "project",
      frameworkSessionId: "session",
      threadId: "thread",
      generation: 2,
      checkpointId: "checkpoint-1",
      projectionSeq: 4,
      projectionHeadHash: "head-hash",
      createdAt: "2026-06-22T00:00:00.000Z",
      state: { collapse: { committed: ["span-a"] } },
    };
  }

  it("atomically writes, validates and creates a framework-neutral pointer", async () => {
    const directory = await temporaryDirectory();
    const log = new ProjectionLog(join(directory, "projection.jsonl"));
    const record = await log.append("compact", { summary: "summary" });
    const value = { ...checkpoint(), projectionSeq: record.seq, projectionHeadHash: record.hash };
    const path = join(directory, "checkpoint.json");
    const stored = await writeCheckpointAtomic(path, value);
    const restored = await readCheckpoint(path);
    expect(restored).toEqual({ status: "ok", value: stored });
    const pointer = createCheckpointPointer(stored, "post_compact");
    expect(validateCheckpointPointer(pointer, stored)).toEqual({ valid: true });
    expect(validateCheckpointProjectionHead(stored, [record])).toEqual({ valid: true });
    expect(validateCheckpointProjectionHead(stored, [{ ...record, hash: "different" }])).toEqual({
      valid: false,
      reason: "projection head hash mismatch",
    });
    expect(validateCheckpointPointer({ ...pointer, projectionSeq: 5 }, stored)).toEqual({
      valid: false,
      reason: "projectionSeq mismatch",
    });
    expect(validateCheckpointPointer({ schemaVersion: 1 }, stored)).toEqual({
      valid: false,
      reason: "malformed or unsupported pointer",
    });
  });

  it("degrades instead of returning a tampered checkpoint", async () => {
    const path = join(await temporaryDirectory(), "checkpoint.json");
    await writeCheckpointAtomic(path, checkpoint());
    const stored = JSON.parse(await readFile(path, "utf8")) as { checkpointHash: string };
    stored.checkpointHash = "tampered";
    await writeFile(path, JSON.stringify(stored), "utf8");
    expect(await readCheckpoint(path)).toEqual({
      status: "corrupt",
      reason: "checkpoint hash mismatch",
    });
  });

  it("accepts an empty checkpoint watermark even when later log records exist", async () => {
    const path = join(await temporaryDirectory(), "checkpoint.json");
    const stored = await writeCheckpointAtomic(path, {
      ...checkpoint(),
      projectionSeq: 0,
      projectionHeadHash: "",
    });
    const log = new ProjectionLog(join(await temporaryDirectory(), "projection.jsonl"));
    const later = await log.append("compact", { summary: "later" });
    expect(validateCheckpointProjectionHead(stored, [later])).toEqual({ valid: true });
  });

  it("degrades on a structurally malformed checkpoint", async () => {
    const path = join(await temporaryDirectory(), "checkpoint.json");
    await writeFile(path, JSON.stringify({ checkpoint: { schemaVersion: 1 }, checkpointHash: "x" }), "utf8");
    expect(await readCheckpoint(path)).toEqual({
      status: "corrupt",
      reason: "unsupported or malformed checkpoint",
    });
  });
});
