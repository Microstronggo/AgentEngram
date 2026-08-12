import type { MemoryFormationPipeline, MemoryObservation } from "./memory-formation.js";

/** Minimal pipeline boundary consumed by the legacy observation scheduler. */
export interface FormationPipelineRunner {
  /** Runs one long-term-memory formation observation. */
  form(observation: MemoryObservation): Promise<unknown>;
}

/** Bounded project context pre-injected into an observation before extraction. */
export interface FormationManifest {
  readonly memoryIndex?: string;
  readonly headers?: readonly string[];
}

/** Observation plus scheduler metadata used for coalescing and policy. */
export interface ScheduledFormationObservation extends MemoryObservation {
  /** True when the primary agent already performed an explicit memory write. */
  readonly alreadyWrittenByAgent?: boolean;
  /** Existing bounded memory surface injected before candidate extraction. */
  readonly manifest?: FormationManifest;
}

/** Durable watermark advanced only after a successful observation batch. */
export interface FormationCursorStore {
  load(): Promise<string | undefined>;
  save(cursor: string): Promise<void>;
}

/** Pipeline, cursor, and restricted-execution policy for background formation. */
export interface FormationSchedulerOptions {
  readonly pipeline: MemoryFormationPipeline | FormationPipelineRunner;
  readonly cursorStore?: FormationCursorStore;
  readonly restrictedExecutor?: RestrictedFormationExecutor;
  readonly clock?: () => Date;
}

/** Latest-wins batch identified by the source transcript or event cursor. */
export interface FormationBatch {
  readonly cursor: string;
  readonly observations: readonly ScheduledFormationObservation[];
}

/** Observable batch outcome including cursor and skip accounting. */
export interface FormationSchedulerRunResult {
  readonly status: "idle" | "completed" | "skipped" | "failed";
  readonly cursor?: string;
  readonly processed: number;
  readonly skipped: number;
  readonly error?: unknown;
}

/** Optional sandbox boundary for model-backed formation work. */
export interface RestrictedFormationExecutor {
  readonly policy: RestrictedFormationPolicy;
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** Capabilities allowed inside a restricted formation execution. */
export interface RestrictedFormationPolicy {
  readonly allowRead: true;
  readonly memoryWriteRoot: string;
  readonly allowShell: false;
  readonly allowMcp: false;
  readonly allowAgentSpawn: false;
}

/** Minimal policy object used by background memory formation workers. */
export function createRestrictedFormationPolicy(memoryWriteRoot: string): RestrictedFormationPolicy {
  const root = memoryWriteRoot.trim();
  if (!root) throw new Error("memoryWriteRoot is required");
  return {
    allowRead: true,
    memoryWriteRoot: root,
    allowShell: false,
    allowMcp: false,
    allowAgentSpawn: false,
  };
}

/** In-process executor that exposes the restricted background-formation contract to tests and adapters. */
export class InProcessRestrictedFormationExecutor implements RestrictedFormationExecutor {
  readonly policy: RestrictedFormationPolicy;

  constructor(memoryWriteRoot: string) {
    this.policy = createRestrictedFormationPolicy(memoryWriteRoot);
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return task();
  }
}

/** Coalesced scheduler work and listeners waiting for its final result. */
interface PendingRun {
  readonly batch: FormationBatch;
  readonly resolve: (value: FormationSchedulerRunResult) => void;
  readonly reject: (reason?: unknown) => void;
  readonly promise: Promise<FormationSchedulerRunResult>;
}

/** Latest-wins scheduler for coalesced background long-term-memory formation. */
export class FormationScheduler {
  /** Currently executing batch, if any. */
  private inFlight: Promise<FormationSchedulerRunResult> | undefined;
  /** Newest queued batch retained while an older batch is still running. */
  private trailing: PendingRun | undefined;
  /** Set by drain() so shutdown stops accepting additional work. */
  private closed = false;

  /** @param options Pipeline, cursor persistence, and optional restricted executor. */
  constructor(private readonly options: FormationSchedulerOptions) {}

  async currentCursor(): Promise<string | undefined> {
    return this.options.cursorStore?.load();
  }

  /**
   * Schedule a background extraction batch. If extraction is already running,
   * only the newest queued batch is retained; all callers receive the eventual
   * result for that latest trailing run.
   */
  schedule(batch: FormationBatch): Promise<FormationSchedulerRunResult> {
    if (this.closed) return Promise.resolve({ status: "skipped", processed: 0, skipped: batch.observations.length });
    validateBatch(batch);
    if (!this.inFlight) {
      this.inFlight = this.runLoop(batch);
      return this.inFlight;
    }
    const pending = makePending(batch);
    const superseded = this.trailing;
    this.trailing = pending;
    superseded?.resolve({ status: "skipped", processed: 0, skipped: superseded.batch.observations.length });
    return pending.promise;
  }

  async drain(options: { readonly timeoutMs?: number } = {}): Promise<"drained" | "timeout"> {
    // Drain is used by runtime shutdown/tests to make background memory writes
    // observable without blocking the primary agent loop on every turn.
    this.closed = true;
    const active = this.inFlight;
    if (!active) return "drained";
    if (options.timeoutMs === undefined) {
      await active;
      return "drained";
    }
    return Promise.race([
      active.then(() => "drained" as const),
      delay(options.timeoutMs).then(() => "timeout" as const),
    ]);
  }

  private async runLoop(batch: FormationBatch): Promise<FormationSchedulerRunResult> {
    let result = await this.execute(batch);
    while (this.trailing) {
      // Latest-wins semantics: execute only the newest queued batch, resolving
      // any superseded pending promise as skipped in schedule().
      const pending = this.trailing;
      this.trailing = undefined;
      const trailingResult = await this.execute(pending.batch);
      pending.resolve(trailingResult);
      result = trailingResult;
    }
    this.inFlight = undefined;
    return result;
  }

  private async execute(batch: FormationBatch): Promise<FormationSchedulerRunResult> {
    const run = async (): Promise<FormationSchedulerRunResult> => {
      let processed = 0;
      let skipped = 0;
      try {
        for (const observation of batch.observations) {
          if (observation.alreadyWrittenByAgent) {
            // Explicit user/tool writes already produced a durable record; avoid
            // duplicating that same fact in the background formation pass.
            skipped++;
            continue;
          }
          await this.options.pipeline.form(withManifestPreInjection(observation));
          processed++;
        }
        if (this.options.cursorStore) await this.options.cursorStore.save(batch.cursor);
        return { status: processed === 0 ? "skipped" : "completed", cursor: batch.cursor, processed, skipped };
      } catch (error) {
        return { status: "failed", cursor: batch.cursor, processed, skipped, error };
      }
    };
    return this.options.restrictedExecutor ? this.options.restrictedExecutor.run(run) : run();
  }
}

/** Prepends bounded manifest context without changing the observation's provenance. */
export function withManifestPreInjection(observation: ScheduledFormationObservation): MemoryObservation {
  const manifestText = renderManifest(observation.manifest);
  if (!manifestText) return observation;
  // Manifest pre-injection gives the extractor awareness of existing memory
  // headers without granting it direct storage access.
  return {
    text: `${manifestText}\n\n${observation.text}`,
    sourceRefs: observation.sourceRefs,
    ...(observation.projectId === undefined ? {} : { projectId: observation.projectId }),
    metadata: {
      ...observation.metadata,
      manifestPreInjected: true,
    },
  };
}

function renderManifest(manifest: FormationManifest | undefined): string {
  if (!manifest) return "";
  const parts: string[] = [];
  if (manifest.memoryIndex?.trim()) parts.push(`# MEMORY.md\n${manifest.memoryIndex.trim()}`);
  const headers = [...(manifest.headers ?? [])].map((header) => header.trim()).filter(Boolean);
  if (headers.length > 0) parts.push(`# Existing memory headers\n${headers.map((header) => `- ${header}`).join("\n")}`);
  return parts.join("\n\n");
}

function validateBatch(batch: FormationBatch): void {
  if (!batch.cursor.trim()) throw new Error("formation cursor is required");
}

function makePending(batch: FormationBatch): PendingRun {
  let resolve!: (value: FormationSchedulerRunResult) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<FormationSchedulerRunResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { batch, resolve, reject, promise };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
