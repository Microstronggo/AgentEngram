import type { NormalizedTranscriptEntry } from "../../../transcript/normalized-transcript-entry.js";
import type { CellBoundaryDetectorLike } from "./cell-boundary.js";
import type {
  CellFormationState,
  DeadLetterCell,
  PendingCell,
} from "./cell-formation-state.js";
import type {
  CellFormationStateIdentity,
  CellFormationStateRepository,
} from "./cell-formation-state-repository.js";
import type { EpisodeFormationStageResult } from "./cell-memory-formation.js";
import type { FormationCell } from "./formation-cell.js";
import type { FormationResult, MemoryCandidate } from "./memory-formation.js";
import type { MemoryRecord } from "../records/memory-record.js";
import { transcriptEntriesToBoundaryEntries } from "./transcript-boundary-entry.js";

/** Cursor-aware normalized transcript source consumed by Cell scans. */
export interface CellFormationTranscriptSource {
  readNormalizedAfter(input: {
    readonly sessionId: string;
    readonly threadId: string;
    readonly cursor?: string;
  }): Promise<readonly NormalizedTranscriptEntry[]>;
}

/** One serialized transcript scan, optionally flushing the ambiguous tail. */
export interface CellFormationRequest extends CellFormationStateIdentity {
  /** Flushes the ambiguous tail when a session/thread is being left. */
  readonly isFinal?: boolean;
}

/** Closed, completed, pending, and dead-letter counts for one scan. */
export interface CellFormationRunResult {
  readonly status: "idle" | "completed" | "failed";
  readonly closedCells: number;
  readonly completedCells: number;
  readonly pendingCells: number;
  readonly deadLetteredCells: number;
  readonly error?: unknown;
}

/** Retry classification persisted with failed staged Cell work. */
export type CellFormationErrorKind = "transient" | "permanent" | "timeout";

/** Durable coordinator dependencies and retry limits. */
export interface CellFormationCoordinatorOptions {
  readonly projectId: string;
  readonly transcripts: CellFormationTranscriptSource;
  readonly states: CellFormationStateRepository;
  readonly boundaryDetector: CellBoundaryDetectorLike;
  readonly formation: CellFormationStageRunner;
  readonly clock?: () => Date;
  /** Maximum wall time for one serialized thread scan, including model calls. */
  readonly taskTimeoutMs?: number;
  /** Immediate retries for malformed/transient boundary model responses. */
  readonly boundaryMaxAttempts?: number;
  /** Attempts per Episode or Derived stage before the Cell is dead-lettered. */
  readonly stageMaxAttempts?: number;
  /** Base delay for persisted exponential retry backoff. */
  readonly retryBaseDelayMs?: number;
  readonly classifyError?: (error: unknown) => CellFormationErrorKind;
}

/** Episode-first staged formation boundary used by the durable outbox. */
export interface CellFormationStageRunner {
  formEpisode(
    cell: FormationCell,
    options?: { readonly signal?: AbortSignal },
  ): Promise<EpisodeFormationStageResult>;
  extractDerived(
    cell: FormationCell,
    episode: MemoryRecord,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly MemoryCandidate[]>;
  formDerivedCandidate(
    cell: FormationCell,
    candidate: MemoryCandidate,
  ): Promise<readonly FormationResult[]>;
}

/** Error marker for invalid state or non-retriable provider/configuration failures. */
export class PermanentCellFormationError extends Error {
  override readonly name = "PermanentCellFormationError";
}

/** Durable per-thread coordinator for transcript boundary detection and staged formation. */
export class CellFormationCoordinator {
  /** Promise tails serialize state transitions independently for every thread. */
  private readonly queues = new Map<string, Promise<CellFormationRunResult>>();
  /** Active tasks tracked so shutdown/tests can await durable formation work. */
  private readonly active = new Set<Promise<CellFormationRunResult>>();
  /** Known identities make pending/retry/dead-letter state observable to diagnostics. */
  private readonly identities = new Map<string, CellFormationStateIdentity>();
  private readonly clock: () => Date;

  public constructor(private readonly options: CellFormationCoordinatorOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** Schedules one transcript scan; repeated lifecycle triggers are cursor-idempotent. */
  public schedule(request: CellFormationRequest): Promise<CellFormationRunResult> {
    const key = stateKey(request);
    this.identities.set(key, { sessionId: request.sessionId, threadId: request.threadId });
    const previous = this.queues.get(key);
    const task = (previous ? previous.catch(() => idleResult()) : Promise.resolve(idleResult()))
      .then(() => this.runWithTimeout(request));
    this.queues.set(key, task);
    this.active.add(task);
    void task.finally(() => {
      this.active.delete(task);
      if (this.queues.get(key) === task) this.queues.delete(key);
    });
    return task;
  }

  /** Forces the current Tail into a Cell and waits for its staged formation attempt. */
  public flush(request: CellFormationStateIdentity): Promise<CellFormationRunResult> {
    return this.schedule({ ...request, isFinal: true });
  }

  /** Returns persisted worker state without exposing transcript content outside diagnostics. */
  public async inspect(sessionId?: string): Promise<readonly {
    identity: CellFormationStateIdentity;
    state: CellFormationState;
  }[]> {
    const identities = [...this.identities.values()].filter((identity) => !sessionId || identity.sessionId === sessionId);
    return Promise.all(identities.map(async (identity) => ({ identity, state: await this.options.states.load(identity) })));
  }

  /** Waits for all tasks known at each drain iteration, including queued followers. */
  public async drain(options: { readonly timeoutMs?: number } = {}): Promise<"drained" | "timeout"> {
    const work = async () => {
      while (this.active.size > 0) await Promise.allSettled([...this.active]);
      return "drained" as const;
    };
    if (options.timeoutMs === undefined) return work();
    return Promise.race([work(), delay(options.timeoutMs).then(() => "timeout" as const)]);
  }

  private async runWithTimeout(request: CellFormationRequest): Promise<CellFormationRunResult> {
    const timeoutMs = Math.max(1, this.options.taskTimeoutMs ?? 60_000);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new DOMException(`Cell formation timed out after ${timeoutMs}ms`, "TimeoutError");
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.run(request, controller.signal), timeout]);
    } catch (error) {
      const state = await this.options.states.load(request).catch(() => undefined);
      return {
        status: "failed",
        closedCells: 0,
        completedCells: 0,
        pendingCells: state?.pendingCells.length ?? 0,
        deadLetteredCells: state?.deadLetters.length ?? 0,
        error,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async run(request: CellFormationRequest, signal: AbortSignal): Promise<CellFormationRunResult> {
    let state = normalizeState(await this.options.states.load(request));
    const fresh = await this.options.transcripts.readNormalizedAfter({
      sessionId: request.sessionId,
      threadId: request.threadId,
      ...(state.transcriptCursor ? { cursor: state.transcriptCursor } : {}),
    });
    const boundaryEntries = transcriptEntriesToBoundaryEntries(fresh);
    const shouldDetect = boundaryEntries.length > 0 || (request.isFinal === true && state.tail.length > 0);
    let closedCells = 0;

    if (fresh.length > 0 || shouldDetect) {
      const detection = shouldDetect
        ? await this.detectWithRetry({
            entries: boundaryEntries,
            priorTail: state.tail,
            projectId: this.options.projectId,
            sessionId: request.sessionId,
            threadId: request.threadId,
            isFinal: request.isFinal === true,
            signal,
          })
        : { cells: [], tail: state.tail };
      closedCells = detection.cells.length;
      const knownIds = new Set([
        ...state.pendingCells.map(({ cell }) => cell.id),
        ...state.deadLetters.map(({ cell }) => cell.id),
      ]);
      const appended: PendingCell[] = detection.cells
        .filter((cell) => !knownIds.has(cell.id))
        .map((cell) => ({ cell, stage: "episode", attempts: 0 }));
      state = {
        ...state,
        ...(fresh.at(-1) ? { transcriptCursor: fresh.at(-1)!.id } : {}),
        tail: detection.tail,
        pendingCells: [...state.pendingCells, ...appended],
        updatedAt: this.clock().toISOString(),
      };
      // Cursor, Tail, and pending outbox advance in one durable snapshot.
      await this.options.states.save(request, state);
    }

    const formation = await this.processPending(request, state, signal);
    return {
      status: formation.hadFailure
        ? "failed"
        : closedCells === 0 && formation.completedCells === 0 ? "idle" : "completed",
      closedCells,
      completedCells: formation.completedCells,
      pendingCells: formation.state.pendingCells.length,
      deadLetteredCells: formation.state.deadLetters.length,
      ...(formation.error === undefined ? {} : { error: formation.error }),
    };
  }

  private async detectWithRetry(input: Parameters<CellBoundaryDetectorLike["detect"]>[0]) {
    const maxAttempts = Math.max(1, this.options.boundaryMaxAttempts ?? 3);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.options.boundaryDetector.detect(input);
      } catch (error) {
        lastError = error;
        if (this.classifyError(error) === "permanent" || attempt === maxAttempts) throw error;
      }
    }
    throw lastError;
  }

  private async processPending(
    identity: CellFormationStateIdentity,
    initialState: CellFormationState,
    signal: AbortSignal,
  ): Promise<{
    readonly completedCells: number;
    readonly state: CellFormationState;
    readonly hadFailure: boolean;
    readonly error?: unknown;
  }> {
    let state = initialState;
    let completedCells = 0;
    let hadFailure = false;
    let lastError: unknown;
    const attemptedThisRun = new Set<string>();

    while (true) {
      const index = nextReadyPendingIndex(state, this.clock(), attemptedThisRun);
      if (index < 0) break;
      const pending = state.pendingCells[index]!;
      attemptedThisRun.add(pending.cell.id);
      try {
        if (pending.stage === "episode") {
          const result = await this.options.formation.formEpisode(pending.cell, { signal });
          if (!result.episode) {
            state = removePending(state, index, this.clock);
            completedCells++;
            await this.options.states.save(identity, state);
            continue;
          }
          state = replacePending(state, index, clearRetry({
            ...pending,
            stage: "derived",
            episode: result.episode,
            attempts: 0,
          }), this.clock);
          await this.options.states.save(identity, state);
          attemptedThisRun.delete(pending.cell.id);
          continue;
        }

        if (!pending.episode) throw new PermanentCellFormationError("derived pending Cell is missing its parent episode");
        if (!pending.derivedCandidates) {
          const candidates = await this.options.formation.extractDerived(pending.cell, pending.episode, { signal });
          // This save is the extraction/write transaction boundary. All later
          // retries consume exactly these candidates instead of calling the LLM again.
          state = replacePending(state, index, clearRetry({
            ...pending,
            derivedCandidates: structuredClone(candidates),
            derivedCursor: 0,
            attempts: 0,
          }), this.clock);
          await this.options.states.save(identity, state);
          attemptedThisRun.delete(pending.cell.id);
          continue;
        }

        const cursor = pending.derivedCursor ?? 0;
        const candidate = pending.derivedCandidates[cursor];
        if (!candidate) {
          state = removePending(state, index, this.clock);
          completedCells++;
          await this.options.states.save(identity, state);
          continue;
        }
        await this.options.formation.formDerivedCandidate(pending.cell, candidate);
        state = replacePending(state, index, clearRetry({
          ...pending,
          derivedCursor: cursor + 1,
          attempts: 0,
        }), this.clock);
        await this.options.states.save(identity, state);
        attemptedThisRun.delete(pending.cell.id);
      } catch (error) {
        hadFailure = true;
        lastError = error;
        state = await this.persistFailure(identity, state, index, pending, error);
      }
    }
    return { completedCells, state, hadFailure, ...(lastError === undefined ? {} : { error: lastError }) };
  }

  private async persistFailure(
    identity: CellFormationStateIdentity,
    state: CellFormationState,
    index: number,
    pending: PendingCell,
    error: unknown,
  ): Promise<CellFormationState> {
    const kind = this.classifyError(error);
    const attempts = pending.attempts + 1;
    const maxAttempts = Math.max(1, this.options.stageMaxAttempts ?? 3);
    if (kind === "permanent" || attempts >= maxAttempts) {
      const deadLetter: DeadLetterCell = {
        ...pending,
        attempts,
        errorKind: kind,
        lastError: errorMessage(error),
        deadLetteredAt: this.clock().toISOString(),
      };
      const next = deadLetterPending(state, index, deadLetter, this.clock);
      await this.options.states.save(identity, next);
      return next;
    }
    const base = Math.max(0, this.options.retryBaseDelayMs ?? 1_000);
    const nextRetryAt = new Date(this.clock().getTime() + base * 2 ** (attempts - 1)).toISOString();
    const next = replacePending(state, index, {
      ...pending,
      attempts,
      errorKind: kind,
      lastError: errorMessage(error),
      nextRetryAt,
    }, this.clock);
    await this.options.states.save(identity, next);
    return next;
  }

  private classifyError(error: unknown): CellFormationErrorKind {
    if (this.options.classifyError) return this.options.classifyError(error);
    if (error instanceof PermanentCellFormationError) return "permanent";
    if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return "timeout";
    const message = errorMessage(error);
    if (/\b(?:HTTP )?(?:400|401|403|404|422)\b|invalid (?:api key|state|configuration)/iu.test(message)) return "permanent";
    return "transient";
  }
}

function normalizeState(state: CellFormationState): CellFormationState {
  return { ...state, deadLetters: state.deadLetters ?? [] };
}

function clearRetry(pending: PendingCell): PendingCell {
  const { lastError: _lastError, errorKind: _errorKind, nextRetryAt: _nextRetryAt, ...rest } = pending;
  return rest;
}

function nextReadyPendingIndex(state: CellFormationState, now: Date, attempted: ReadonlySet<string>): number {
  return state.pendingCells.findIndex((pending) => {
    if (attempted.has(pending.cell.id)) return false;
    return !pending.nextRetryAt || Date.parse(pending.nextRetryAt) <= now.getTime();
  });
}

function replacePending(
  state: CellFormationState,
  index: number,
  pending: PendingCell,
  clock: () => Date,
): CellFormationState {
  return {
    ...state,
    pendingCells: state.pendingCells.map((value, cursor) => cursor === index ? pending : value),
    updatedAt: clock().toISOString(),
  };
}

function removePending(state: CellFormationState, index: number, clock: () => Date): CellFormationState {
  return {
    ...state,
    pendingCells: state.pendingCells.filter((_value, cursor) => cursor !== index),
    updatedAt: clock().toISOString(),
  };
}

function deadLetterPending(
  state: CellFormationState,
  index: number,
  deadLetter: DeadLetterCell,
  clock: () => Date,
): CellFormationState {
  return {
    ...removePending(state, index, clock),
    deadLetters: [...state.deadLetters, deadLetter],
    updatedAt: clock().toISOString(),
  };
}

function stateKey(identity: CellFormationStateIdentity): string {
  return `${identity.sessionId}\0${identity.threadId}`;
}

function idleResult(): CellFormationRunResult {
  return { status: "idle", closedCells: 0, completedCells: 0, pendingCells: 0, deadLetteredCells: 0 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
