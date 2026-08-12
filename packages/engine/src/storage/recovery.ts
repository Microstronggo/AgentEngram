import type { CheckpointPointerV1, StoredCheckpoint } from "./checkpoint/index.js";
import {
  readCheckpoint,
  validateCheckpointPointer,
  validateCheckpointProjectionHead,
} from "./checkpoint/index.js";
import { readProjectionLog, type ProjectionLogRecord } from "./projection-log/index.js";

/** Result of validating a checkpoint against its committed projection-log prefix. */
export type RecoveryResult =
  | { readonly status: "recovered"; readonly checkpoint: StoredCheckpoint; readonly committedLog: readonly ProjectionLogRecord[] }
  | { readonly status: "rebuild"; readonly reason: string };

/** Restores only the committed WAL prefix selected by a framework pointer. */
export async function recoverCommittedProjection(input: {
  readonly pointer: CheckpointPointerV1;
  readonly checkpointPath: string;
  readonly projectionLogPath: string;
}): Promise<RecoveryResult> {
  const checkpoint = await readCheckpoint(input.checkpointPath);
  if (checkpoint.status !== "ok") return { status: "rebuild", reason: `checkpoint ${checkpoint.status}` };
  const pointer = validateCheckpointPointer(input.pointer, checkpoint.value);
  if (!pointer.valid) return { status: "rebuild", reason: pointer.reason };
  const log = await readProjectionLog(input.projectionLogPath);
  if (log.status === "corrupt" && log.records.length < input.pointer.projectionSeq) {
    return { status: "rebuild", reason: "projection log corrupt before committed watermark" };
  }
  const committedLog = log.records.slice(0, input.pointer.projectionSeq);
  const head = validateCheckpointProjectionHead(checkpoint.value, committedLog);
  if (!head.valid) return { status: "rebuild", reason: head.reason };
  return { status: "recovered", checkpoint: checkpoint.value, committedLog };
}
