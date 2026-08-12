import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MemoryContextProjector,
  validateProjectedMessages,
  type ContextProjector,
  type ProjectionInput,
  type RecalledMemoryContext,
} from "../context/index.js";
import {
  LongTermMemoryService,
  MarkdownMemoryStore,
  SqliteFtsMemoryIndex,
  AutoCompactCircuitBreaker,
  CollapseController,
  compactTranscript,
  compactFromSessionMemory,
  createToolResultBudgetState,
  extractAndSaveSessionMemory,
  type CompactBoundary,
  type CompactSummarizer,
  type CollapseSnapshot,
  FormationScheduler,
  CellBoundaryDetector,
  CellFormationCoordinator,
  CellMemoryFormationPipeline,
  DefaultDuplicateResolver,
  DefaultMemoryContentScanner,
  DefaultSignificanceEvaluator,
  LEGACY_PARTITION_IDS,
  FileCellFormationStateRepository,
  allowDefaultAutomaticScope,
  type CellBoundaryDetectorLike,
  type FormationResult,
  type MemoryFormationPipeline,
  type MemoryCandidate,
  type MemoryObservation,
  type SessionMemory,
  type SessionMemoryExtractor,
  type SessionMemoryRepository,
  type ToolResultBudgetState,
  SqliteMemoryUsageStore,
} from "../memory/index.js";
import {
  LLMBoundaryDecisionModel,
  LLMDerivedMemoryExtractor,
  LLMEpisodeCandidateExtractor,
  type LLMChatClient,
  type ModelResolutionContext,
  type TaskModelResolver,
} from "../llm/index.js";
import type {
  AgentEvent,
  AgentMessage,
  ContextRequest,
  ContextView,
  HostModelBridge,
  HostModelReference,
} from "../protocol/index.js";
import {
  BlobStore,
  ProjectionLog,
  createCheckpointPointer,
  recoverCommittedProjection,
  ensureDataLayout,
  writeCheckpointAtomic,
  type CheckpointPointerV1,
  type CheckpointReason,
  type JsonValue,
  type ProjectionCheckpoint,
  projectStorageRoot,
  storagePathSegment,
} from "../storage/index.js";
import { TranscriptStore, type TranscriptAppendInput } from "../transcript/index.js";
import { AgentEngramRuntime } from "./agent-engram.js";
import { EventRouter } from "./event-router.js";
import { MemoryApplicationService } from "./memory-application-service.js";
import { ContextPipeline } from "../context/index.js";
import { DurableJobRuntime, type DurableMemoryJob } from "./durable-job-runtime.js";
import type { CellFormationRunResult } from "../memory/index.js";
import { WorkerExecutionRunner, type WorkerExecutionMode } from "./worker-execution.js";

/** Composition options for the complete filesystem-backed AgentEngram runtime. */
export interface LocalAgentEngramRuntimeOptions {
  /** AgentEngram data root; adapters may override it with AGENTENGRAM_HOME. */
  readonly homeDir: string;
  /** Canonical project identity used to isolate transcripts, memory, and state. */
  readonly projectId: string;
  /** Uses the active framework model by default; the adapter supplies the implementation. */
  readonly summarizer?: CompactSummarizer;
  readonly sessionExtractor?: SessionMemoryExtractor<AgentMessage>;
  readonly formation?: MemoryFormationPipeline;
  readonly formationScheduler?: FormationScheduler;
  /** Shared model client for Cell boundary detection and staged long-term formation. */
  readonly llmClient?: LLMChatClient;
  /** Resolves task-specific configured/current-model policy at worker execution time. */
  readonly taskModelResolver?: TaskModelResolver;
  /** Adapter bridge used to capture and later invoke an exact host model reference. */
  readonly modelBridge?: HostModelBridge<LLMChatClient>;
  /** Host metadata supplied to provider-neutral task model resolution. */
  readonly modelResolutionContext?: Omit<ModelResolutionContext, "sessionId" | "threadId" | "canInvokeCurrentModel">;
  /** Selects the automatic long-term formation path; Cell mode disables legacy turn observations. */
  readonly formationMode?: "cell" | "turn-observation" | "disabled";
  /** Injectable boundary detector for deterministic tests or host-specific policies. */
  readonly boundaryDetector?: CellBoundaryDetectorLike;
  /**
   * Controls who executes durable model jobs. Embedded runtimes poll locally,
   * sidecar-backed runtimes only enqueue work, and external runtimes are drained by
   * an adapter-owned worker process.
   */
  readonly workerExecutionMode?: WorkerExecutionMode;
  readonly contextMode?: "enhance" | "managed-context";
  readonly failOpen?: boolean;
  readonly toolResultTokenBudget?: number;
  readonly recallLimit?: number;
  readonly recallTokenBudget?: number;
}

/** Managed-context compaction request over canonical normalized messages. */
export interface LocalCompactRequest {
  readonly sessionId: string;
  readonly threadId: string;
  readonly messages: readonly AgentMessage[];
  readonly keepRecentTokens: number;
  readonly signal?: AbortSignal;
}

/** Replacement messages plus the durable boundary used for later recovery. */
export interface LocalCompactResult {
  readonly messages: readonly AgentMessage[];
  readonly boundary: CompactBoundary;
}

/** Snapshot request anchored to the current session/thread projection log. */
export interface LocalCheckpointRequest {
  readonly sessionId: string;
  readonly threadId: string;
  readonly reason: CheckpointReason;
  readonly messages?: readonly AgentMessage[];
  readonly state?: Readonly<Record<string, unknown>>;
}

/** Recovery outcome that requires rebuild when validation cannot prove safety. */
export interface LocalRecoveryResult {
  readonly status: "restored" | "rebuild";
  readonly reason?: string;
  readonly messages: readonly AgentMessage[];
  readonly sessionMemory?: SessionMemory;
}

/** Engine-owned state serialized inside a projection checkpoint. */
interface RuntimeCheckpointState {
  readonly messages: readonly AgentMessage[];
  readonly sessionMemory?: SessionMemory;
  readonly collapse?: readonly { readonly effectiveWindowTokens: number; readonly snapshot: CollapseSnapshot }[];
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** Atomic JSON repository for the task state injected on every context build. */
export class FileSessionMemoryRepository implements SessionMemoryRepository {
  /** @param rootDir Directory containing one atomic snapshot per session. */
  constructor(private readonly rootDir: string) {}

  async load(sessionId: string): Promise<SessionMemory | undefined> {
    try {
      const value = JSON.parse(await readFile(this.pathFor(sessionId), "utf8")) as unknown;
      if (!isSessionMemory(value)) throw new Error("stored session memory is malformed");
      return value;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async save(sessionId: string, memory: SessionMemory): Promise<void> {
    const target = this.pathFor(sessionId);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(memory)}\n`, "utf8");
      await file.sync();
      await file.close();
      await rename(temporary, target);
      const directory = await open(dirname(target), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private pathFor(sessionId: string): string {
    return join(this.rootDir, `${storagePathSegment(sessionId)}.json`);
  }
}

/**
 * Production local-first composition root. Markdown/checkpoint/JSONL/blob files are
 * truth sources; SQLite is a closeable, rebuildable recall projection.
 */
export class LocalAgentEngramRuntime extends AgentEngramRuntime {
  /** Long-term memory write, formation, recall, and archival service. */
  readonly longTerm: LongTermMemoryService;
  /** Shared native-tool/MCP application boundary. */
  readonly application: MemoryApplicationService;
  /** Durable structured task-state repository. */
  readonly sessionMemory: SessionMemoryRepository;
  /** Content-addressed storage for offloaded canonical tool output. */
  readonly blobs: BlobStore;
  /** Portable transcript source of truth mirrored from host framework hooks. */
  readonly transcripts: TranscriptStore;
  /** True only when a model-backed compact summarizer has been supplied. */
  readonly managedContextReady: boolean;

  /** Rebuildable FTS database connection owned by this runtime. */
  private readonly index: SqliteFtsMemoryIndex;
  /** Persistent weak/strong recall feedback projection. */
  private readonly usage: SqliteMemoryUsageStore;
  /** Immutable local composition and policy configuration. */
  private readonly options: LocalAgentEngramRuntimeOptions;
  /** Stateful short-term projection layer, including Collapse snapshots. */
  private readonly memoryProjector: LocalMemoryProjector;
  /** Per-runtime auto-compact circuit breaker; opens after repeated model failures. */
  private readonly compactCircuitBreaker = new AutoCompactCircuitBreaker(3);
  /** Last valid projected context per stable session/thread. */
  private readonly lastContexts: Map<string, readonly AgentMessage[]>;
  /** Optional background long-term formation scheduler; failures do not block the agent loop. */
  private readonly formationScheduler: FormationScheduler | undefined;
  /** Durable transcript-driven Cell worker used by the default automatic formation path. */
  private readonly cellFormationCoordinator: CellFormationCoordinator | undefined;
  /** Persistent wake-up queue for model-backed work that must survive host restarts. */
  private readonly jobs: DurableJobRuntime | undefined;
  /** Ephemeral return values for callers that synchronously drain a newly enqueued Cell job. */
  private readonly cellJobResults: Map<string, CellFormationRunResult>;
  /** Enqueue/drain promises tracked before the underlying coordinator becomes active. */
  private readonly cellScheduling = new Set<Promise<CellFormationRunResult | undefined>>();
  /** Next checkpoint generation per stable session/thread. */
  private readonly generations = new Map<string, number>();
  /** Guards every public operation after owned resources are closed. */
  private closed = false;

  private constructor(options: LocalAgentEngramRuntimeOptions, dependencies: LocalDependencies) {
    const projector = new LocalMemoryProjector(options, dependencies, (request, messages) => {
      dependencies.lastContexts.set(threadKey(request.sessionId, request.threadId), structuredClone(messages));
    });
    const events = new EventRouter([async (event) => dependencies.onEvent(event)]);
    super({
      context: new ContextPipeline({
        mode: options.contextMode ?? "enhance",
        failOpen: options.failOpen ?? true,
        projectors: [projector],
      }),
      events,
    });
    this.options = options;
    this.memoryProjector = projector;
    this.index = dependencies.index;
    this.usage = dependencies.usage;
    this.longTerm = dependencies.longTerm;
    this.application = dependencies.application.attachRuntime(this);
    this.sessionMemory = dependencies.sessionMemory;
    this.blobs = dependencies.blobs;
    this.transcripts = dependencies.transcripts;
    this.lastContexts = dependencies.lastContexts;
    this.formationScheduler = dependencies.formationScheduler;
    this.cellFormationCoordinator = dependencies.cellFormationCoordinator;
    this.jobs = dependencies.jobs;
    this.cellJobResults = dependencies.cellJobResults;
    this.managedContextReady = options.summarizer !== undefined;
  }

  static async create(options: LocalAgentEngramRuntimeOptions): Promise<LocalAgentEngramRuntime> {
    if (!options.homeDir) throw new Error("homeDir is required");
    if (!options.projectId) throw new Error("projectId is required");
    await ensureDataLayout(options.homeDir);
    await mkdir(join(options.homeDir, "indexes"), { recursive: true, mode: 0o700 });
    const memoryDatabasePath = join(options.homeDir, "indexes", "memory.db");
    const index = new SqliteFtsMemoryIndex(memoryDatabasePath);
    const usage = new SqliteMemoryUsageStore(memoryDatabasePath);
    const store = new MarkdownMemoryStore(options.homeDir);
    const longTerm = new LongTermMemoryService(store, index, options.formation, () => new Date(), usage);
    const application = new MemoryApplicationService(store, index, undefined, new DefaultMemoryContentScanner(), usage);
    const projectRoot = projectStorageRoot(options.homeDir, options.projectId);
    const runtimeRoot = join(projectRoot, "runtime");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const sessionMemory = new FileSessionMemoryRepository(join(projectRoot, "session-memory"));
    const blobs = new BlobStore(join(projectRoot, "blobs"));
    const transcripts = new TranscriptStore({ rootDir: projectRoot });
    const lastContexts = new Map<string, readonly AgentMessage[]>();
    const formationMode = options.formationMode ?? (options.llmClient
      ? "cell"
      : options.formation || options.formationScheduler ? "turn-observation" : "disabled");
    if (formationMode === "cell" && !options.llmClient) {
      throw new Error("cell formation requires llmClient");
    }
    // Legacy turn observations are mutually exclusive with Cell formation so
    // one transcript segment cannot generate two independent memory families.
    const formationScheduler = formationMode === "turn-observation"
      ? options.formationScheduler ?? (options.formation
        ? new FormationScheduler({ pipeline: { form: (observation: MemoryObservation) => longTerm.form(observation) } })
        : undefined)
      : undefined;
    const cellFormationCoordinator = formationMode === "cell" && options.llmClient
      ? createCellFormationCoordinator({
          projectId: options.projectId,
          projectRoot,
          client: options.llmClient,
          ...(options.boundaryDetector === undefined ? {} : { boundaryDetector: options.boundaryDetector }),
          transcripts,
          store,
          application,
        })
      : undefined;
    const cellJobResults = new Map<string, CellFormationRunResult>();
    const workerExecutionMode = options.workerExecutionMode ?? "embedded";
    const jobs = cellFormationCoordinator || workerExecutionMode === "sidecar"
      ? new DurableJobRuntime({
          // A Cell handler closes over one project-specific coordinator. Keeping
          // its queue beside that project prevents another runtime from claiming
          // a job with the same session/thread identity under a different project.
          databasePath: join(runtimeRoot, "memory-jobs.db"),
          handlers: cellFormationCoordinator ? {
            "cell.formation": async (job: DurableMemoryJob) => {
              const payload = cellFormationJobPayload(job);
              // A durable job binds all Cell stages to one client. This prevents
              // a host model_select event from mixing boundary, episode, and
              // derived-memory outputs inside the same formation transaction.
              const client = await resolveCellJobClient(options, payload);
              const coordinator = client === options.llmClient
                ? cellFormationCoordinator
                : createCellFormationCoordinator({
                    projectId: options.projectId,
                    projectRoot,
                    client,
                    ...(options.boundaryDetector === undefined ? {} : { boundaryDetector: options.boundaryDetector }),
                    transcripts,
                    store,
                    application,
                  });
              const result = payload.isFinal
                ? await coordinator.flush(payload)
                : await coordinator.schedule(payload);
              cellJobResults.set(job.jobId, result);
              if (result.status === "failed") throw result.error ?? new Error("Cell formation failed");
            },
          } : {},
        })
      : undefined;
    if (workerExecutionMode === "embedded" && jobs) {
      await new WorkerExecutionRunner({ mode: "embedded", embedded: jobs }).ensureAvailable();
    } else if (workerExecutionMode === "external") {
      await new WorkerExecutionRunner({ mode: "external" }).ensureAvailable();
    }
    const dependencies: LocalDependencies = {
      index, usage, longTerm, application, sessionMemory, blobs, transcripts, lastContexts, cellJobResults,
      ...(formationScheduler === undefined ? {} : { formationScheduler }),
      ...(cellFormationCoordinator === undefined ? {} : { cellFormationCoordinator }),
      ...(jobs === undefined ? {} : { jobs }),
      onEvent: async (event) => {
        if (event.eventType !== "turn.completed" || !formationScheduler) return;
        const observation = memoryObservationFromEvent(event, options.projectId);
        if (observation) {
          // Fire-and-forget by design: formation failures are reported through
          // scheduler results/drain tests and must not fail the live agent turn.
          void formationScheduler.schedule({ cursor: event.eventId, observations: [observation] });
        }
      },
    };
    return new LocalAgentEngramRuntime(options, dependencies);
  }

  override async buildContext(request: ContextRequest): Promise<ContextView> {
    this.assertOpen();
    const view = await super.buildContext(request);
    if (view.source === "fail-open" && view.diagnostics?.ownership?.fallbackReason) {
      await this.recordContextFallback(request.sessionId, request.threadId, view.diagnostics.ownership);
    }
    this.lastContexts.set(threadKey(request.sessionId, request.threadId), structuredClone(view.messages));
    return view;
  }

  /** Persists an ownership transfer so fail-open behavior remains auditable after restart. */
  async recordContextFallback(
    sessionId: string,
    threadId: string,
    ownership: import("../protocol/index.js").ContextOwnershipDiagnostic,
  ): Promise<void> {
    this.assertOpen();
    await this.projectionLog(sessionId, threadId).append("context.ownership-fallback", toJson(ownership));
  }

  override handle(event: AgentEvent) {
    this.assertOpen();
    return super.handle(event);
  }

  async updateSessionMemory(input: {
    readonly sessionId: string;
    readonly messages: readonly AgentMessage[];
    readonly signal?: AbortSignal;
  }): Promise<SessionMemory> {
    this.assertOpen();
    if (!this.options.sessionExtractor) throw new Error("session memory extractor is not configured");
    return extractAndSaveSessionMemory({
      ...input,
      extractor: this.options.sessionExtractor,
      repository: this.sessionMemory,
    });
  }

  formLongTermMemory(observation: MemoryObservation): Promise<readonly FormationResult[]> {
    this.assertOpen();
    return this.longTerm.form(observation);
  }

  async appendTranscript(input: TranscriptAppendInput | readonly TranscriptAppendInput[]): Promise<void> {
    this.assertOpen();
    // Transcript mirroring is append-only and idempotent at the store layer, so
    // repeated hook invocations can safely replay the same Pi branch.
    const records = Array.isArray(input) ? input : [input];
    await this.transcripts.appendMany(records);
  }

  async drainFormation(options: { readonly timeoutMs?: number } = {}): Promise<"drained" | "timeout"> {
    this.assertOpen();
    // Tests and online harnesses call this to make background memory formation
    // deterministic after a turn has completed.
    const scheduling = async () => {
      while (this.cellScheduling.size > 0) await Promise.allSettled([...this.cellScheduling]);
      const jobs = await this.jobs?.drain(options) ?? "drained";
      if (jobs === "timeout") return "timeout" as const;
      return drainFormationWorkers(this.formationScheduler, this.cellFormationCoordinator, options);
    };
    if (options.timeoutMs === undefined) return scheduling();
    return Promise.race([
      scheduling(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), options.timeoutMs)),
    ]);
  }

  /** Scans newly mirrored transcript entries and schedules closed Cells for formation. */
  scheduleCellFormation(input: { readonly sessionId: string; readonly threadId: string }) {
    this.assertOpen();
    return this.trackCellScheduling(this.runDurableCellJob(input, false));
  }

  /** Closes the current ambiguous Tail before a session or thread is left. */
  flushCellFormation(input: { readonly sessionId: string; readonly threadId: string }) {
    this.assertOpen();
    return this.trackCellScheduling(this.runDurableCellJob(input, true));
  }

  /**
   * Persists one idempotent Cell job without executing provider work. Command
   * hooks use this producer path so model latency never blocks the host turn.
   */
  async enqueueCellFormation(input: {
    readonly sessionId: string;
    readonly threadId: string;
    readonly isFinal?: boolean;
  }): Promise<DurableMemoryJob | undefined> {
    this.assertOpen();
    if (!this.jobs) return undefined;
    const fresh = await this.transcripts.readNormalizedAfter(input);
    const cursor = fresh.at(-1)?.id ?? "empty";
    const isFinal = input.isFinal === true;
    // Persist only credential-free identity. The adapter resolves credentials
    // immediately before execution through HostModelBridge.invokeClient().
    const modelReference = await this.options.modelBridge?.currentModel();
    const jobId = `cell_${createHash("sha256").update(JSON.stringify({
      projectId: this.options.projectId,
      sessionId: input.sessionId,
      threadId: input.threadId,
      cursor,
      isFinal,
      modelReference,
    })).digest("hex").slice(0, 24)}`;
    return this.jobs.enqueue({
      jobId,
      kind: "cell.formation",
      partitionKey: this.options.projectId,
      payload: {
        sessionId: input.sessionId,
        threadId: input.threadId,
        isFinal,
        ...(modelReference === undefined ? {} : { modelReference }),
      },
    });
  }

  /** Executes currently ready durable jobs from an adapter-owned worker. */
  runReadyBackgroundJobs(limit = 32): Promise<number> {
    this.assertOpen();
    return this.jobs?.runReady(limit) ?? Promise.resolve(0);
  }

  /** Returns durable job state for worker idle detection and diagnostics. */
  listBackgroundJobs() {
    this.assertOpen();
    return this.jobs?.list() ?? [];
  }

  /** Includes durable Cell retry/outbox state alongside ordinary session events. */
  override async inspectDiagnostics(sessionId?: string): Promise<unknown> {
    const events = super.inspectDiagnostics(sessionId) as Record<string, unknown>;
    const formation = await this.cellFormationCoordinator?.inspect(sessionId) ?? [];
    return { ...events, cellFormation: formation, backgroundJobs: this.jobs?.list() ?? [] };
  }

  async compact(request: LocalCompactRequest): Promise<LocalCompactResult> {
    this.assertOpen();
    if (!this.options.summarizer) throw new Error("managed-context requires a compact summarizer");
    const sessionMemory = await this.sessionMemory.load(request.sessionId);
    if (sessionMemory) {
      // Prefer an existing structured session memory summary when it can safely
      // replace the prefix without another model call.
      const sessionCompacted = compactFromSessionMemory(request.messages, {
        sessionMemory,
        autoCompactThresholdTokens: request.keepRecentTokens * 4,
      });
      if (sessionCompacted) {
        await this.projectionLog(request.sessionId, request.threadId).append("compact.completed", toJson(sessionCompacted.boundary));
        this.lastContexts.set(threadKey(request.sessionId, request.threadId), structuredClone(sessionCompacted.messages));
        return sessionCompacted;
      }
    }
    // Fall back to model-backed compaction. The circuit breaker prevents repeated
    // summarizer failures from destabilizing managed-context mode.
    const result = await compactTranscript(request.messages, {
      keepRecentTokens: request.keepRecentTokens,
      summarizer: this.options.summarizer,
      circuitBreaker: this.compactCircuitBreaker,
      ...(sessionMemory === undefined ? {} : { sessionMemory }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    await this.projectionLog(request.sessionId, request.threadId).append("compact.completed", toJson(result.boundary));
    this.lastContexts.set(threadKey(request.sessionId, request.threadId), structuredClone(result.messages));
    return result;
  }

  async createCheckpoint(request: LocalCheckpointRequest): Promise<CheckpointPointerV1> {
    this.assertOpen();
    const log = await this.projectionLog(request.sessionId, request.threadId).read();
    if (log.status === "corrupt") throw new Error(`projection log corrupt at line ${log.line}: ${log.reason}`);
    const head = log.records.at(-1);
    const key = threadKey(request.sessionId, request.threadId);
    const generation = (this.generations.get(key) ?? 0) + 1;
    const checkpointId = randomUUID();
    const sessionMemory = await this.sessionMemory.load(request.sessionId);
    const state: RuntimeCheckpointState = {
      messages: structuredClone(request.messages ?? this.lastContexts.get(key) ?? []),
      ...(sessionMemory === undefined ? {} : { sessionMemory }),
      collapse: this.memoryProjector.collapseState(request.sessionId, request.threadId),
      ...(request.state === undefined ? {} : { extra: request.state }),
    };
    const checkpoint: ProjectionCheckpoint = {
      schemaVersion: 1,
      projectId: this.options.projectId,
      frameworkSessionId: request.sessionId,
      threadId: request.threadId,
      generation,
      checkpointId,
      projectionSeq: head?.seq ?? 0,
      projectionHeadHash: head?.hash ?? "",
      createdAt: new Date().toISOString(),
      state: toJson(state),
    };
    const stored = await writeCheckpointAtomic(this.checkpointPath(request.sessionId, request.threadId, checkpointId), checkpoint);
    this.generations.set(key, generation);
    return createCheckpointPointer(stored, request.reason);
  }

  async recover(pointer: CheckpointPointerV1): Promise<LocalRecoveryResult> {
    this.assertOpen();
    if (pointer.projectId !== this.options.projectId) {
      return { status: "rebuild", reason: "projectId mismatch", messages: [] };
    }
    const recovered = await recoverCommittedProjection({
      pointer,
      checkpointPath: this.checkpointPath(pointer.frameworkSessionId, pointer.threadId, pointer.checkpointId),
      projectionLogPath: this.projectionLogPath(pointer.frameworkSessionId, pointer.threadId),
    });
    if (recovered.status === "rebuild") return { status: "rebuild", reason: recovered.reason, messages: [] };
    const state = recovered.checkpoint.checkpoint.state as unknown as RuntimeCheckpointState;
    if (!Array.isArray(state.messages)) return { status: "rebuild", reason: "checkpoint context is malformed", messages: [] };
    try {
      validateProjectedMessages(state.messages);
    } catch (error) {
      return { status: "rebuild", reason: `checkpoint context is invalid: ${errorMessage(error)}`, messages: [] };
    }
    if (state.sessionMemory !== undefined && !isSessionMemory(state.sessionMemory)) {
      return { status: "rebuild", reason: "checkpoint session memory is malformed", messages: [] };
    }
    try {
      this.memoryProjector.restoreCollapseState(pointer.frameworkSessionId, pointer.threadId, state.collapse ?? []);
    } catch (error) {
      return { status: "rebuild", reason: `checkpoint collapse state is invalid: ${errorMessage(error)}`, messages: [] };
    }
    const key = threadKey(pointer.frameworkSessionId, pointer.threadId);
    this.lastContexts.set(key, structuredClone(state.messages));
    this.generations.set(key, pointer.generation);
    if (state.sessionMemory) await this.sessionMemory.save(pointer.frameworkSessionId, state.sessionMemory);
    return {
      status: "restored",
      messages: structuredClone(state.messages),
      ...(state.sessionMemory === undefined ? {} : { sessionMemory: state.sessionMemory }),
    };
  }

  rebuildFromCanonical(sessionId: string, threadId: string, messages: readonly AgentMessage[]): LocalRecoveryResult {
    this.assertOpen();
    const restored = structuredClone(messages);
    this.lastContexts.set(threadKey(sessionId, threadId), restored);
    return { status: "restored", messages: restored };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Give background formation a bounded chance to persist Markdown + FTS state
    // before closing the rebuildable SQLite projection.
    // Sidecar-backed hooks own no worker and must remain a fast path. Draining here
    // would accidentally execute or wait for work assigned to the sidecar.
    if ((this.options.workerExecutionMode ?? "embedded") !== "sidecar") {
      await this.drainFormation({ timeoutMs: 1_000 });
    }
    await this.jobs?.close();
    this.closed = true;
    this.transcripts.close();
    this.usage.close();
    this.index.close();
  }

  private projectionLog(sessionId: string, threadId: string): ProjectionLog {
    return new ProjectionLog(this.projectionLogPath(sessionId, threadId));
  }

  private projectionLogPath(sessionId: string, threadId: string): string {
    return join(this.threadDirectory(sessionId, threadId), "projection.jsonl");
  }

  private checkpointPath(sessionId: string, threadId: string, checkpointId: string): string {
    return join(this.threadDirectory(sessionId, threadId), "checkpoints", `${storagePathSegment(checkpointId)}.json`);
  }

  private threadDirectory(sessionId: string, threadId: string): string {
    return join(projectStorageRoot(this.options.homeDir, this.options.projectId), "threads", storagePathSegment(sessionId), storagePathSegment(threadId));
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("LocalAgentEngramRuntime is closed");
  }

  private async runDurableCellJob(
    input: { readonly sessionId: string; readonly threadId: string },
    isFinal: boolean,
  ): Promise<CellFormationRunResult | undefined> {
    if (!this.jobs) return undefined;
    const job = await this.enqueueCellFormation({ ...input, isFinal });
    if (!job || (this.options.workerExecutionMode ?? "embedded") !== "embedded") return undefined;
    const jobId = job.jobId;
    const completed = await this.jobs.runJob(jobId);
    return this.cellJobResults.get(jobId) ?? (completed?.status === "dead_letter"
      ? { status: "failed", closedCells: 0, completedCells: 0, pendingCells: 0, deadLetteredCells: 1, error: completed.lastError }
      : undefined);
  }

  private trackCellScheduling(task: Promise<CellFormationRunResult | undefined>): Promise<CellFormationRunResult | undefined> {
    this.cellScheduling.add(task);
    void task.then(
      () => this.cellScheduling.delete(task),
      () => this.cellScheduling.delete(task),
    );
    return task;
  }
}

/** Fully composed services retained by LocalAgentEngramRuntime after creation. */
interface LocalDependencies {
  readonly index: SqliteFtsMemoryIndex;
  readonly usage: SqliteMemoryUsageStore;
  readonly longTerm: LongTermMemoryService;
  readonly application: MemoryApplicationService;
  readonly sessionMemory: SessionMemoryRepository;
  readonly blobs: BlobStore;
  readonly transcripts: TranscriptStore;
  readonly lastContexts: Map<string, readonly AgentMessage[]>;
  readonly formationScheduler?: FormationScheduler;
  readonly cellFormationCoordinator?: CellFormationCoordinator;
  readonly jobs?: DurableJobRuntime;
  readonly cellJobResults: Map<string, CellFormationRunResult>;
  readonly onEvent: (event: AgentEvent) => Promise<void>;
}

function cellFormationJobPayload(job: DurableMemoryJob): {
  readonly sessionId: string;
  readonly threadId: string;
  readonly isFinal: boolean;
  readonly modelReference?: HostModelReference;
} {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new Error("invalid Cell formation job payload");
  }
  const payload = job.payload as Record<string, unknown>;
  if (typeof payload.sessionId !== "string" || typeof payload.threadId !== "string" || typeof payload.isFinal !== "boolean") {
    throw new Error("invalid Cell formation job identity");
  }
  const modelReference = decodeHostModelReference(payload.modelReference);
  return {
    sessionId: payload.sessionId,
    threadId: payload.threadId,
    isFinal: payload.isFinal,
    ...(modelReference === undefined ? {} : { modelReference }),
  };
}

/** Validates the credential-free model identity stored in a durable job. */
function decodeHostModelReference(value: unknown): HostModelReference | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Cell formation model reference");
  const record = value as Record<string, unknown>;
  if (typeof record.model !== "string" || !record.model.trim()) throw new Error("invalid Cell formation model reference");
  if (record.provider !== undefined && (typeof record.provider !== "string" || !record.provider.trim())) {
    throw new Error("invalid Cell formation model provider");
  }
  if (record.selectedAt !== undefined && (typeof record.selectedAt !== "string" || !Number.isFinite(Date.parse(record.selectedAt)))) {
    throw new Error("invalid Cell formation model timestamp");
  }
  return {
    model: record.model.trim(),
    ...(typeof record.provider === "string" ? { provider: record.provider.trim() } : {}),
    ...(typeof record.selectedAt === "string" ? { selectedAt: record.selectedAt } : {}),
  };
}

/** Resolves one immutable client for every LLM stage in a Cell formation job. */
async function resolveCellJobClient(
  options: LocalAgentEngramRuntimeOptions,
  payload: ReturnType<typeof cellFormationJobPayload>,
): Promise<LLMChatClient> {
  if (payload.modelReference && options.modelBridge) {
    const bound = await options.modelBridge.invokeClient(payload.modelReference);
    if (bound) return bound;
  }
  if (options.taskModelResolver) {
    const context: ModelResolutionContext = {
      ...(options.modelResolutionContext ?? {}),
      sessionId: payload.sessionId,
      threadId: payload.threadId,
      canInvokeCurrentModel: options.modelBridge !== undefined,
      metadata: {
        ...(options.modelResolutionContext?.metadata ?? {}),
        ...(payload.modelReference === undefined ? {} : { modelReference: payload.modelReference }),
      },
    };
    const resolved = await options.taskModelResolver.resolve("memory-formation", context);
    if (resolved) return resolved.client;
  }
  if (options.llmClient) return options.llmClient;
  throw new Error("Cell formation model is unavailable");
}

/** Project-aware composition of short-term policies and long-term recall. */
class LocalMemoryProjector implements ContextProjector {
  /** Stable stage name used in context diagnostics. */
  readonly name = "local-agent-engram";
  /** Idempotence state for tool-result offload decisions per thread. */
  private readonly toolStates = new Map<string, ToolResultBudgetState>();
  /** Stateful proactive Collapse controllers keyed by thread and context window. */
  private readonly collapseControllers = new Map<string, CollapseController>();

  /**
   * @param options Runtime policy and project identity.
   * @param dependencies Durable stores and services shared with the composition root.
   * @param projected Callback that captures the last validated context for checkpoints.
   */
  constructor(
    private readonly options: LocalAgentEngramRuntimeOptions,
    private readonly dependencies: LocalDependencies,
    private readonly projected: (request: ContextRequest, messages: readonly AgentMessage[]) => void,
  ) {}

  async project(input: ProjectionInput): Promise<readonly AgentMessage[]> {
    const key = threadKey(input.request.sessionId, input.request.threadId);
    let toolResultBudget: ConstructorParameters<typeof MemoryContextProjector>[0]["toolResultBudget"];
    if (input.mode === "managed-context") {
      const state = this.toolStates.get(key) ?? createToolResultBudgetState();
      this.toolStates.set(key, state);
      toolResultBudget = {
        state,
        options: {
          maxTokensPerMessage: this.options.toolResultTokenBudget ?? 8_000,
          offloader: {
            put: async (_toolCallId, output) => {
              const encoded = typeof output === "string"
                ? { value: output, mediaType: "text/plain; charset=utf-8" }
                : { value: JSON.stringify(output) ?? String(output), mediaType: "application/json" };
              const blob = await this.dependencies.blobs.put(encoded.value, encoded.mediaType);
              return {
                uri: `blob:sha256:${blob.digest}`,
                metadata: {
                  algorithm: blob.algorithm,
                  digest: blob.digest,
                  byteLength: blob.byteLength,
                  mediaType: blob.mediaType,
                },
              };
            },
          },
        },
      };
    }
    const effectiveWindow = input.request.contextWindow === undefined
      ? undefined
      : input.request.contextWindow - (input.request.reservedOutputTokens ?? 0);
    const collapse = input.mode === "managed-context" && this.options.summarizer && effectiveWindow !== undefined && effectiveWindow >= 8_000
      ? this.collapseController(input, effectiveWindow)
      : undefined;
    const projector = new MemoryContextProjector({
      ...(toolResultBudget === undefined ? {} : { toolResultBudget }),
      microcompact: () => ({
        now: new Date(),
        coldAfterMs: 5 * 60_000,
        keepRecentToolResults: 3,
        algorithmVersion: "microcompact-time-v1",
        configVersion: "local-v1",
      }),
      historySnip: (projection, currentTokens) => {
        const window = projection.request.contextWindow;
        if (window === undefined || window < 32_000 || currentTokens < window * 0.7) return undefined;
        return {
          targetTokensToFree: 4_000,
          protectedTailTokens: Math.min(32_000, Math.max(8_000, Math.floor(window * 0.15))),
        };
      },
      ...(collapse === undefined ? {} : { collapse }),
      // Collapse and proactive compact are mutually exclusive. Small/unknown windows
      // retain compact as the only model-generated pressure valve.
      ...(collapse !== undefined || this.options.summarizer === undefined
        ? {}
        : { compact: { summarizer: this.options.summarizer } }),
      loadSessionMemory: (sessionId) => this.dependencies.sessionMemory.load(sessionId),
      recall: async ({ query, projectId, limit }) => this.recall(
        query,
        projectId,
        limit,
        typeof input.request.metadata?.worktreeId === "string" ? input.request.metadata.worktreeId : undefined,
      ),
      decisions: {
        append: async (kind, payload) => {
          await new ProjectionLog(projectionLogPath(this.options, input.request.sessionId, input.request.threadId))
            .append(kind, toJson(payload));
        },
      },
    });
    const messages = await projector.project(input);
    this.projected(input.request, messages);
    return messages;
  }

  collapseState(sessionId: string, threadId: string): readonly {
    readonly effectiveWindowTokens: number;
    readonly snapshot: CollapseSnapshot;
  }[] {
    const prefix = `${threadKey(sessionId, threadId)}\0`;
    return [...this.collapseControllers.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, controller]) => ({
        effectiveWindowTokens: Number(key.slice(prefix.length)),
        snapshot: controller.snapshot(),
      }));
  }

  restoreCollapseState(
    sessionId: string,
    threadId: string,
    states: readonly { readonly effectiveWindowTokens: number; readonly snapshot: CollapseSnapshot }[],
  ): void {
    const restored: Array<readonly [string, CollapseController]> = [];
    for (const state of states) {
      if (!Number.isFinite(state.effectiveWindowTokens) || state.effectiveWindowTokens < 8_000) {
        throw new Error("invalid collapse effective window");
      }
      restored.push([
        collapseKey(sessionId, threadId, state.effectiveWindowTokens),
        this.newCollapseController(state.effectiveWindowTokens, state.snapshot),
      ]);
    }
    const prefix = `${threadKey(sessionId, threadId)}\0`;
    for (const key of this.collapseControllers.keys()) if (key.startsWith(prefix)) this.collapseControllers.delete(key);
    for (const [key, controller] of restored) this.collapseControllers.set(key, controller);
  }

  private collapseController(input: ProjectionInput, effectiveWindowTokens: number): CollapseController {
    const key = collapseKey(input.request.sessionId, input.request.threadId, effectiveWindowTokens);
    let controller = this.collapseControllers.get(key);
    if (!controller) {
      controller = this.newCollapseController(effectiveWindowTokens);
      this.collapseControllers.set(key, controller);
    }
    return controller;
  }

  private newCollapseController(effectiveWindowTokens: number, snapshot?: CollapseSnapshot): CollapseController {
    const summarizer = this.options.summarizer;
    if (!summarizer) throw new Error("collapse summarizer is not configured");
    return new CollapseController({
      effectiveWindowTokens,
      ...(snapshot === undefined ? {} : { snapshot }),
      summarizer: {
        summarize: async ({ candidate, messages, signal }) => {
          const start = messages.findIndex(({ id }) => id === candidate.startEventId);
          const end = messages.findIndex(({ id }) => id === candidate.endEventId);
          if (start < 0 || end < start) throw new Error("collapse candidate is not present in the transcript");
          const result = await summarizer.summarize({
            messages: messages.slice(start, end + 1),
            instructions: [
              "Summarize only this historical span for context collapse.",
              "Preserve goals, decisions, failures, file changes, pending work, and provenance.",
              "Do not add facts that are not present in the span.",
            ],
            ...(signal === undefined ? {} : { signal }),
          });
          return { summary: result.text };
        },
      },
    });
  }

  private async recall(
    query: string,
    projectId: string | undefined,
    limit: number,
    worktreeId?: string,
  ): Promise<readonly RecalledMemoryContext[]> {
    if (!query.trim()) return [];
    const result = this.dependencies.longTerm.search({
      query,
      projectId: projectId ?? this.options.projectId,
      maxResults: Math.min(limit, this.options.recallLimit ?? limit),
      tokenBudget: this.options.recallTokenBudget ?? 2_000,
      audience: {
        projectId: projectId ?? this.options.projectId,
        worktreeId: worktreeId ?? LEGACY_PARTITION_IDS.worktreeId,
        userId: LEGACY_PARTITION_IDS.userId,
        agentId: LEGACY_PARTITION_IDS.agentId,
        teamIds: [LEGACY_PARTITION_IDS.teamId],
      },
    });
    return result.memories.map(({ record }) => ({
      id: record.id,
      scope: record.scope,
      content: record.content,
      sourceRefs: record.sourceRefs,
    }));
  }
}

function memoryObservationFromEvent(event: AgentEvent, projectId: string): MemoryObservation | undefined {
  const value = event.metadata?.memoryObservation;
  if (typeof value === "string" && value.trim()) {
    return { text: value, sourceRefs: [event.eventId], projectId };
  }
  if (value && typeof value === "object" && "text" in value && typeof value.text === "string" && value.text.trim()) {
    const sourceRefs = "sourceRefs" in value && Array.isArray(value.sourceRefs)
      ? value.sourceRefs.filter((item): item is string => typeof item === "string")
      : [event.eventId];
    return { text: value.text, sourceRefs, projectId, metadata: event.metadata };
  }
  return undefined;
}

/** Builds the complete transcript-to-memory worker owned by the Engine runtime. */
function createCellFormationCoordinator(input: {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly client: LLMChatClient;
  readonly boundaryDetector?: CellBoundaryDetectorLike;
  readonly transcripts: TranscriptStore;
  readonly store: MarkdownMemoryStore;
  readonly application: MemoryApplicationService;
}): CellFormationCoordinator {
  const formation = new CellMemoryFormationPipeline({
    episodeExtractor: new LLMEpisodeCandidateExtractor({ client: input.client }),
    derivedExtractor: new LLMDerivedMemoryExtractor({ client: input.client }),
    evaluator: new DefaultSignificanceEvaluator(),
    duplicates: new DefaultDuplicateResolver(input.store),
    scanner: new DefaultMemoryContentScanner(),
    writer: { put: (record) => input.application.putRecord(record) },
    allowScope: allowDefaultAutomaticScope,
    // A Cell plus normalized candidate identity produces stable record ids.
    // Retrying after a crash therefore replaces the same Markdown record and
    // FTS row rather than creating duplicate memories.
    idFactory: stableCellMemoryId,
  });
  return new CellFormationCoordinator({
    projectId: input.projectId,
    transcripts: input.transcripts,
    states: new FileCellFormationStateRepository(input.projectRoot),
    boundaryDetector: input.boundaryDetector ?? new CellBoundaryDetector({
      model: new LLMBoundaryDecisionModel({ client: input.client }),
    }),
    formation,
  });
}

/** Stable idempotency key shared by episode and derived formation retries. */
function stableCellMemoryId(candidate: MemoryCandidate, observation: MemoryObservation): string {
  const seed = JSON.stringify({
    formationCellId: observation.metadata?.formationCellId ?? observation.sourceRefs,
    memoryClass: candidate.memoryClass,
    scope: candidate.scope,
    type: candidate.type,
    content: candidate.content.trim(),
    parentMemoryIds: candidate.parentMemoryIds ?? [],
  });
  return `mem_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

/** Drains both mutually exclusive workers defensively if a custom composition supplies both. */
async function drainFormationWorkers(
  legacy: FormationScheduler | undefined,
  cell: CellFormationCoordinator | undefined,
  options: { readonly timeoutMs?: number },
): Promise<"drained" | "timeout"> {
  const results = await Promise.all([
    legacy?.drain(options) ?? Promise.resolve("drained" as const),
    cell?.drain(options) ?? Promise.resolve("drained" as const),
  ]);
  return results.includes("timeout") ? "timeout" : "drained";
}

function projectionLogPath(options: LocalAgentEngramRuntimeOptions, sessionId: string, threadId: string): string {
  return join(projectStorageRoot(options.homeDir, options.projectId), "threads", storagePathSegment(sessionId), storagePathSegment(threadId), "projection.jsonl");
}

function threadKey(sessionId: string, threadId: string): string {
  return `${sessionId}\0${threadId}`;
}

function collapseKey(sessionId: string, threadId: string, effectiveWindowTokens: number): string {
  return `${threadKey(sessionId, threadId)}\0${effectiveWindowTokens}`;
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isSessionMemory(value: unknown): value is SessionMemory {
  if (!value || typeof value !== "object") return false;
  const memory = value as Partial<SessionMemory>;
  const arrays = [
    memory.goals, memory.constraints, memory.decisions, memory.activeFiles,
    memory.completedWork, memory.failedAttempts, memory.pendingTasks, memory.blockers,
  ];
  return memory.version === 1 && typeof memory.updatedAt === "string" &&
    arrays.every((items) => Array.isArray(items) && items.every((item) => typeof item === "string")) &&
    !!memory.verificationState && typeof memory.verificationState === "object" &&
    ["not-run", "passed", "failed", "partial"].includes(memory.verificationState.status) &&
    Array.isArray(memory.verificationState.checks) && memory.verificationState.checks.every((item) => typeof item === "string");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
