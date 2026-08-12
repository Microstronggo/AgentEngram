import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCheckpointPointer, writeCheckpointAtomic, type ProjectionCheckpoint } from "./checkpoint/index.js";
import { ProjectionLog } from "./projection-log/index.js";
import { recoverCommittedProjection } from "./recovery.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it("recovers only the projection log prefix committed by the pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentengram-recovery-")); roots.push(root);
  const logPath = join(root, "projection.jsonl");
  const log = new ProjectionLog(logPath);
  const committed = await log.append("compact", { summary: "one" });
  const checkpoint: ProjectionCheckpoint = {
    schemaVersion: 1, projectId: "p", frameworkSessionId: "s", threadId: "t", generation: 1,
    checkpointId: "c", projectionSeq: committed.seq, projectionHeadHash: committed.hash,
    createdAt: "2026-06-22T00:00:00.000Z", state: { ok: true },
  };
  const checkpointPath = join(root, "checkpoint.json");
  const stored = await writeCheckpointAtomic(checkpointPath, checkpoint);
  const pointer = createCheckpointPointer(stored, "post_compact");
  await log.append("uncommitted", { summary: "two" });
  const result = await recoverCommittedProjection({ pointer, checkpointPath, projectionLogPath: logPath });
  expect(result.status).toBe("recovered");
  if (result.status === "recovered") expect(result.committedLog).toHaveLength(1);
});
