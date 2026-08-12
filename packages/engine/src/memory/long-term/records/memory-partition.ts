import { createHash } from "node:crypto";
import type { MemoryScope } from "./memory-record.js";

/** Identity dimensions that isolate durable memory independently from visibility scope. */
export interface MemoryPartition {
  readonly schemaVersion: 1;
  readonly appId?: string;
  readonly userId?: string;
  readonly agentId?: string;
  readonly teamId?: string;
  readonly projectId?: string;
  readonly worktreeId?: string;
  readonly namespace?: string;
}

/** Identity of the caller used to calculate which memory lanes are visible. */
export interface RecallAudience extends Omit<MemoryPartition, "schemaVersion" | "teamId"> {
  readonly teamIds?: readonly string[];
}

/** Stable compatibility identities assigned only to records created before partition-aware adapters. */
export const LEGACY_PARTITION_IDS = {
  userId: "__legacy_default_user__",
  agentId: "__legacy_default_agent__",
  teamId: "__legacy_default_team__",
  worktreeId: "__legacy_default_worktree__",
} as const;

/** Creates a normalized partition while retaining legacy projectId callers. */
export function createMemoryPartition(
  scope: MemoryScope,
  input: Omit<MemoryPartition, "schemaVersion"> = {},
): MemoryPartition {
  const partition: MemoryPartition = {
    schemaVersion: 1,
    ...optionalTextFields(input),
    ...(scope === "user" && !input.userId ? { userId: LEGACY_PARTITION_IDS.userId } : {}),
    ...(scope === "agent" && !input.agentId ? { agentId: LEGACY_PARTITION_IDS.agentId } : {}),
    ...(scope === "team" && !input.teamId ? { teamId: LEGACY_PARTITION_IDS.teamId } : {}),
    ...(scope === "local" && !input.worktreeId ? { worktreeId: LEGACY_PARTITION_IDS.worktreeId } : {}),
  };
  return partition;
}

/** Rejects partitions that cannot enforce the visibility promised by their scope. */
export function validateMemoryPartition(scope: MemoryScope, partition: MemoryPartition): void {
  if (partition.schemaVersion !== 1) throw new Error("unsupported memory partition schema version");
  if ((scope === "project" || scope === "local") && !partition.projectId) {
    throw new Error(`${scope} memory requires projectId`);
  }
  if (scope === "local" && !partition.worktreeId) throw new Error("local memory requires worktreeId");
  if (scope === "user" && !partition.userId) throw new Error("user memory requires userId");
  if (scope === "agent" && !partition.agentId) throw new Error("agent memory requires agentId");
  if (scope === "team" && !partition.teamId) throw new Error("team memory requires teamId");
}

/** Canonical hash key shared by storage projections, jobs, and idempotent writes. */
export function memoryPartitionKey(partition: MemoryPartition): string {
  const canonical = JSON.stringify({
    appId: partition.appId ?? "",
    userId: partition.userId ?? "",
    agentId: partition.agentId ?? "",
    teamId: partition.teamId ?? "",
    projectId: partition.projectId ?? "",
    worktreeId: partition.worktreeId ?? "",
    namespace: partition.namespace ?? "",
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Applies explicit scope visibility rules instead of treating scope as a storage label. */
export function isPartitionVisible(scope: MemoryScope, partition: MemoryPartition, audience: RecallAudience): boolean {
  if (partition.appId && partition.appId !== audience.appId) return false;
  if (partition.namespace && partition.namespace !== audience.namespace) return false;
  if (scope === "user") return partition.userId === audience.userId;
  if (scope === "agent") return partition.agentId === audience.agentId;
  if (scope === "team") return Boolean(partition.teamId && audience.teamIds?.includes(partition.teamId));
  if (scope === "project") return partition.projectId === audience.projectId;
  return partition.projectId === audience.projectId && partition.worktreeId === audience.worktreeId;
}

function optionalTextFields(input: Omit<MemoryPartition, "schemaVersion">): Omit<MemoryPartition, "schemaVersion"> {
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) => typeof value === "string" && value.trim() ? [[key, value.trim()]] : []),
  );
}
