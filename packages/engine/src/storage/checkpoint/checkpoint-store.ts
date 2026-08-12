import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256, stableStringify, type JsonValue } from "../serialization.js";
import type { ProjectionLogRecord } from "../projection-log/projection-log.js";

/** Lifecycle reason recorded on a framework-visible checkpoint pointer. */
export type CheckpointReason =
  | "periodic"
  | "pre_compact"
  | "post_compact"
  | "tree_change"
  | "shutdown";

/** Atomic Engine snapshot anchored to a committed projection-log watermark. */
export interface ProjectionCheckpoint {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly frameworkSessionId: string;
  readonly threadId: string;
  readonly generation: number;
  readonly checkpointId: string;
  readonly projectionSeq: number;
  readonly projectionHeadHash: string;
  readonly createdAt: string;
  readonly state: JsonValue;
}

/** Checkpoint envelope whose hash protects the complete snapshot payload. */
export interface StoredCheckpoint {
  readonly checkpoint: ProjectionCheckpoint;
  readonly checkpointHash: string;
}

/** Framework-neutral payload suitable for a Pi custom entry or another adapter. */
export interface CheckpointPointerV1 {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly frameworkSessionId: string;
  readonly threadId: string;
  readonly generation: number;
  readonly checkpointId: string;
  readonly projectionSeq: number;
  readonly projectionHeadHash: string;
  readonly checkpointHash: string;
  readonly reason: CheckpointReason;
  readonly createdAt: string;
}

/** Explicit read outcome; corrupt snapshots are never treated as missing. */
export type CheckpointReadResult =
  | { readonly status: "ok"; readonly value: StoredCheckpoint }
  | { readonly status: "missing" }
  | { readonly status: "corrupt"; readonly reason: string };

/** Writes, fsyncs, and atomically publishes one checkpoint envelope. */
export async function writeCheckpointAtomic(
  path: string,
  checkpoint: ProjectionCheckpoint,
): Promise<StoredCheckpoint> {
  const stored: StoredCheckpoint = {
    checkpoint,
    checkpointHash: checkpointHash(checkpoint),
  };
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(`${stableStringify(stored as unknown as JsonValue)}\n`, "utf8");
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await file.close();
  await rename(temporaryPath, path);
  await syncDirectory(dirname(path));
  return stored;
}

/** Reads and verifies a checkpoint envelope without attempting silent repair. */
export async function readCheckpoint(path: string): Promise<CheckpointReadResult> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { status: "missing" };
    throw error;
  }
  let stored: StoredCheckpoint;
  try {
    stored = JSON.parse(content) as StoredCheckpoint;
  } catch {
    return { status: "corrupt", reason: "invalid JSON" };
  }
  if (!isProjectionCheckpoint(stored.checkpoint) || typeof stored.checkpointHash !== "string") {
    return { status: "corrupt", reason: "unsupported or malformed checkpoint" };
  }
  if (checkpointHash(stored.checkpoint) !== stored.checkpointHash) {
    return { status: "corrupt", reason: "checkpoint hash mismatch" };
  }
  return { status: "ok", value: stored };
}

/** Creates the small framework entry that points back to durable Engine state. */
export function createCheckpointPointer(
  stored: StoredCheckpoint,
  reason: CheckpointReason,
): CheckpointPointerV1 {
  const checkpoint = stored.checkpoint;
  return {
    schemaVersion: 1,
    projectId: checkpoint.projectId,
    frameworkSessionId: checkpoint.frameworkSessionId,
    threadId: checkpoint.threadId,
    generation: checkpoint.generation,
    checkpointId: checkpoint.checkpointId,
    projectionSeq: checkpoint.projectionSeq,
    projectionHeadHash: checkpoint.projectionHeadHash,
    checkpointHash: stored.checkpointHash,
    reason,
    createdAt: checkpoint.createdAt,
  };
}

/** Rejects pointers whose identity or watermark differs from the stored snapshot. */
export function validateCheckpointPointer(
  pointer: unknown,
  stored: StoredCheckpoint,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  if (!isCheckpointPointerV1(pointer)) return { valid: false, reason: "malformed or unsupported pointer" };
  const checkpoint = stored.checkpoint;
  if (pointer.projectId !== checkpoint.projectId) return mismatch("projectId");
  if (pointer.frameworkSessionId !== checkpoint.frameworkSessionId) return mismatch("frameworkSessionId");
  if (pointer.threadId !== checkpoint.threadId) return mismatch("threadId");
  if (pointer.generation !== checkpoint.generation) return mismatch("generation");
  if (pointer.checkpointId !== checkpoint.checkpointId) return mismatch("checkpointId");
  if (pointer.projectionSeq !== checkpoint.projectionSeq) return mismatch("projectionSeq");
  if (pointer.projectionHeadHash !== checkpoint.projectionHeadHash) return mismatch("projectionHeadHash");
  if (pointer.createdAt !== checkpoint.createdAt) return mismatch("createdAt");
  if (pointer.checkpointHash !== stored.checkpointHash) {
    return { valid: false, reason: "checkpointHash mismatch" };
  }
  return { valid: true };
}

function mismatch(field: string): { readonly valid: false; readonly reason: string } {
  return { valid: false, reason: `${field} mismatch` };
}

function isProjectionCheckpoint(value: unknown): value is ProjectionCheckpoint {
  if (value === null || typeof value !== "object") return false;
  const checkpoint = value as Partial<ProjectionCheckpoint>;
  return (
    checkpoint.schemaVersion === 1 &&
    typeof checkpoint.projectId === "string" &&
    typeof checkpoint.frameworkSessionId === "string" &&
    typeof checkpoint.threadId === "string" &&
    Number.isSafeInteger(checkpoint.generation) && Number(checkpoint.generation) >= 0 &&
    typeof checkpoint.checkpointId === "string" &&
    Number.isSafeInteger(checkpoint.projectionSeq) && Number(checkpoint.projectionSeq) >= 0 &&
    typeof checkpoint.projectionHeadHash === "string" &&
    typeof checkpoint.createdAt === "string" &&
    checkpoint.state !== undefined
  );
}

/** Runtime guard used before trusting a framework-provided checkpoint pointer. */
export function isCheckpointPointerV1(value: unknown): value is CheckpointPointerV1 {
  if (value === null || typeof value !== "object") return false;
  const pointer = value as Partial<CheckpointPointerV1>;
  return (
    pointer.schemaVersion === 1 &&
    typeof pointer.projectId === "string" &&
    typeof pointer.frameworkSessionId === "string" &&
    typeof pointer.threadId === "string" &&
    Number.isSafeInteger(pointer.generation) && Number(pointer.generation) >= 0 &&
    typeof pointer.checkpointId === "string" &&
    Number.isSafeInteger(pointer.projectionSeq) && Number(pointer.projectionSeq) >= 0 &&
    typeof pointer.projectionHeadHash === "string" &&
    typeof pointer.checkpointHash === "string" &&
    typeof pointer.createdAt === "string" &&
    ["periodic", "pre_compact", "post_compact", "tree_change", "shutdown"].includes(
      pointer.reason ?? "",
    )
  );
}

/** Ensures the checkpoint's watermark actually exists in the recovered append-only log. */
export function validateCheckpointProjectionHead(
  stored: StoredCheckpoint,
  records: readonly ProjectionLogRecord[],
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  const { projectionSeq, projectionHeadHash } = stored.checkpoint;
  if (projectionSeq === 0) {
    return projectionHeadHash === ""
      ? { valid: true }
      : { valid: false, reason: "empty projection watermark mismatch" };
  }
  const head = records[projectionSeq - 1];
  if (head === undefined || head.seq !== projectionSeq) {
    return { valid: false, reason: "projection watermark is missing" };
  }
  if (head.hash !== projectionHeadHash) {
    return { valid: false, reason: "projection head hash mismatch" };
  }
  return { valid: true };
}

function checkpointHash(checkpoint: ProjectionCheckpoint): string {
  return sha256(checkpoint as unknown as JsonValue);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
