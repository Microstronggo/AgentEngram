import type { ConsolidationReport, ConsolidationRequest, MemoryConsolidator } from "./memory-consolidator.js";

/** Last successful maintenance watermark for one consolidation scope. */
export interface DreamState {
  readonly lastConsolidatedAt: number;
  readonly sessionsTouchedSince: number;
}

/** Cross-process lease that prevents overlapping maintenance runs. */
export interface ConsolidationLock {
  tryAcquire(): Promise<(() => Promise<void>) | null>;
}

/** Lock, state, cadence, and consolidation callback for scheduled maintenance. */
export interface DreamCoordinatorOptions {
  readonly consolidator: MemoryConsolidator;
  readonly lock: ConsolidationLock;
  readonly readState: () => Promise<DreamState>;
  readonly recordSuccess: (at: number) => Promise<void>;
  readonly minHours?: number;
  readonly minSessions?: number;
  readonly clock?: () => Date;
}

/** Ordered time gate, session gate, and lock. Failed runs never advance the success clock. */
export class DreamCoordinator {
  /** @param options Time/session gates, exclusive lock, and durable success state. */
  public constructor(private readonly options: DreamCoordinatorOptions) {}

  public async run(request: ConsolidationRequest): Promise<{ status: "skipped"; reason: string } | { status: "completed"; report: ConsolidationReport }> {
    const now = this.options.clock?.() ?? new Date();
    const state = await this.options.readState();
    if (now.getTime() - state.lastConsolidatedAt < (this.options.minHours ?? 24) * 3_600_000) {
      return { status: "skipped", reason: "time-gate" };
    }
    if (state.sessionsTouchedSince < (this.options.minSessions ?? 5)) {
      return { status: "skipped", reason: "session-gate" };
    }
    const release = await this.options.lock.tryAcquire();
    if (!release) return { status: "skipped", reason: "lock-held" };
    try {
      const report = await this.options.consolidator.consolidate({ ...request, now });
      await this.options.recordSuccess(now.getTime());
      return { status: "completed", report };
    } finally {
      await release();
    }
  }
}
