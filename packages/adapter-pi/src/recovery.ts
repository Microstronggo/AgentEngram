import { canonicalBranchMessages } from "./canonical-branch.js";
import { selectActiveCheckpoint } from "./checkpoint.js";
import { piIdentity } from "./event-mapper.js";
import type { PiContext } from "./pi-types.js";
import type { EngineFacade, RecoveryRequest, RecoveryResult } from "./types.js";

/** Holds restored context segments per stable Pi session/thread between hooks. */
export class RecoveryRegistry {
  /** Recovery segments are volatile; durable state remains in Engine checkpoints. */
  private readonly segments = new Map<string, unknown[]>();

  get(sessionId: string, threadId: string): unknown[] | undefined {
    return this.segments.get(key(sessionId, threadId));
  }

  set(sessionId: string, threadId: string, messages: unknown[] | undefined): void {
    const id = key(sessionId, threadId);
    if (messages?.length) this.segments.set(id, messages);
    else this.segments.delete(id);
  }
}

export async function recoverActiveBranch(
  context: PiContext,
  engine: EngineFacade,
  registry: RecoveryRegistry,
  reason: RecoveryRequest["reason"],
  onRestoreError?: (error: unknown) => void,
): Promise<void> {
  const branchEntries = context.sessionManager.getBranch?.() ?? [];
  const identity = piIdentity(context);
  const canonicalMessages = canonicalBranchMessages(branchEntries);
  const pointer = selectActiveCheckpoint(branchEntries, identity.sessionId);
  const sessionFile = context.sessionManager.getSessionFile();
  const request: RecoveryRequest = {
    reason,
    ...(pointer === undefined ? {} : { pointer }),
    canonicalMessages,
    branchEntries,
    cwd: context.cwd,
    ...identity,
    ...(sessionFile === undefined ? {} : { sessionFile }),
  };

  // Engine validates checkpoint/hash/log waterline. An unavailable or rejected pointer rebuilds from truth.
  let restored: RecoveryResult | undefined;
  if (pointer) {
    try {
      restored = await engine.restoreCheckpoint?.(request);
    } catch (error) {
      // A corrupt/missing checkpoint is a recovery miss, not a host-session failure.
      onRestoreError?.(error);
    }
  }
  const result = restored?.status === "restored"
    ? restored
    : await engine.rebuildFromCanonical?.(request);
  registry.set(identity.sessionId, identity.threadId, result?.messages);
}

function key(sessionId: string, threadId: string): string {
  return `${sessionId}\0${threadId}`;
}
