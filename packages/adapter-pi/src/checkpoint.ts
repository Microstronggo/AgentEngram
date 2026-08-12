import { isCheckpointPointerV1 } from "@agentengram/engine/adapter";
import type { PiExtensionApi } from "./pi-types.js";
import { CHECKPOINT_CUSTOM_TYPE, type PiAgentEngramCheckpointV1 } from "./types.js";

export function isCheckpointV1(value: unknown): value is PiAgentEngramCheckpointV1 {
  return isCheckpointPointerV1(value);
}

export function appendCheckpoint(pi: PiExtensionApi, checkpoint: unknown): boolean {
  if (!isCheckpointV1(checkpoint)) return false;
  pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, checkpoint);
  return true;
}

/** Select the newest committed checkpoint that is reachable from the active Pi leaf. */
export function selectActiveCheckpoint(
  branch: readonly unknown[],
  frameworkSessionId: string,
): PiAgentEngramCheckpointV1 | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CHECKPOINT_CUSTOM_TYPE) continue;
    const pointer = entry.data;
    if (isCheckpointV1(pointer) && pointer.frameworkSessionId === frameworkSessionId) return pointer;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
