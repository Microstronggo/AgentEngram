import type { BoundaryEntry } from "./cell-boundary.js";
import type { FormationCell } from "./formation-cell.js";
import type { MemoryRecord } from "../records/memory-record.js";
import type { MemoryCandidate } from "./memory-formation.js";

/** Durable stage marker for resuming a partially processed Cell. */
export type PendingCellStage = "episode" | "derived";

/** Durable outbox item bridging a closed Cell and staged memory formation. */
export interface PendingCell {
  readonly cell: FormationCell;
  readonly stage: PendingCellStage;
  /** Written episode retained so a derived-stage retry never regenerates it. */
  readonly episode?: MemoryRecord;
  /** Frozen LLM output persisted before the first derived write. */
  readonly derivedCandidates?: readonly MemoryCandidate[];
  /** Index of the next frozen candidate that still needs policy/write processing. */
  readonly derivedCursor?: number;
  readonly attempts: number;
  readonly lastError?: string;
  readonly errorKind?: "transient" | "permanent" | "timeout";
  readonly nextRetryAt?: string;
}

/** Terminal item retained for diagnosis without blocking later Cells. */
export interface DeadLetterCell extends PendingCell {
  readonly deadLetteredAt: string;
}

/** Per-project/session/thread checkpoint for transcript-driven Cell formation. */
export interface CellFormationState {
  readonly schemaVersion: 1;
  /** Last normalized transcript entry incorporated into tail or pending Cells. */
  readonly transcriptCursor?: string;
  /** Ambiguous trailing evidence waiting for more transcript entries. */
  readonly tail: readonly BoundaryEntry[];
  /** Closed Cells not yet fully persisted as episodic plus derived memories. */
  readonly pendingCells: readonly PendingCell[];
  /** Permanently failed or retry-exhausted items removed from the live outbox. */
  readonly deadLetters: readonly DeadLetterCell[];
  readonly updatedAt: string;
}

/** Creates a fresh per-thread cursor, tail, outbox, and dead-letter snapshot. */
export function emptyCellFormationState(now = new Date()): CellFormationState {
  return {
    schemaVersion: 1,
    tail: [],
    pendingCells: [],
    deadLetters: [],
    updatedAt: now.toISOString(),
  };
}
