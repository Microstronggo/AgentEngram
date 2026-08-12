import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AgentEngramRuntime,
  DefaultTaskModelResolver,
  LLMClient,
  LLMCompactSummarizer,
  LocalAgentEngramRuntime,
  FileSourceCheckpointRepository,
  FileHostBindingRepository,
  createHostBinding,
  fallbackContextOwnership,
  resolveProjectIdentity,
  type AgentEvent,
  type AgentMessage,
  type CompactSummarizer,
  type ContextRequest as EngineContextRequest,
  type LLMChatClient,
  type HostBinding,
  type MemoryFormationPipeline,
  type MessageContent,
  type TaskModelResolver,
  type AgentEngramProviderConfig,
} from "@agentengram/engine";
import type { AdapterEvent, CompactRequest, ContextProjectionResult, ContextRequest, EngineFacade, ManagedCompaction, MemoryApplicationFacade, TranscriptMirrorRequest } from "./types.js";
import { ingestPiBranchIncrementally } from "./transcript/pi-branch-ingestion.js";
import { PI_HOST_CAPABILITIES } from "./capabilities.js";
import { PiCurrentModelLLMClient } from "./pi-current-model-client.js";
import type { PiContext } from "./pi-types.js";

/** Bridges the stable Pi adapter surface to the framework-neutral Engine runtime. */
export class RuntimeEngineFacade implements EngineFacade {
  /** Generic runtimes cannot promise the full atomic managed-context lifecycle. */
  readonly managedContextReady: boolean;
  /** Cached git/worktree identities avoid repeated filesystem discovery per turn. */
  private readonly projectIdentities = new Map<string, ReturnType<typeof resolveProjectIdentity>>();
  /** @param runtime Framework-neutral runtime receiving normalized Pi data. */
  constructor(readonly runtime: AgentEngramRuntime) {
    this.managedContextReady = isManagedContextRuntime(runtime);
  }

  async handleEvent(event: AdapterEvent): Promise<void> {
    const mapped = toAgentEvent(event);
    if (mapped) await this.runtime.handle(mapped);
  }

  async enhanceContext(request: ContextRequest): Promise<unknown[]> {
    return (await this.projectContext(request, "enhance")).messages;
  }

  async buildManagedContext(request: ContextRequest): Promise<unknown[]> {
    return (await this.projectContext(request, "managed-context")).messages;
  }

  /** Preserves Engine fallback/ownership diagnostics for adapters that support them. */
  async projectContextView(request: ContextRequest): Promise<ContextProjectionResult> {
    return this.projectContext(request, request.mode);
  }

  async compact(request: CompactRequest): Promise<ManagedCompaction | undefined> {
    // Managed compaction is available only when the underlying runtime exposes
    // the local compact API. Generic EngineFacade instances fail open here.
    if (!isCompactCapableRuntime(this.runtime)) return undefined;
    const preparation = piCompactionPreparation(request.preparation);
    const messages = request.canonicalMessages.map(toAgentMessage);
    const result = await this.runtime.compact({
      sessionId: request.sessionId,
      threadId: request.threadId,
      messages,
      keepRecentTokens: preparation.keepRecentTokens,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const summary = compactSummaryText(result.messages);
    if (!summary) return undefined;
    // Pi needs the summary and firstKeptEntryId to create a CustomEntry that
    // replaces its pre-compact transcript prefix. AgentEngram keeps the full
    // boundary in details for audit and later rehydration.
    return {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: result.boundary.preCompactTokens,
      details: {
        agentengram: {
          boundary: result.boundary,
          summaryModel: result.boundary.summaryModel,
        },
      },
    };
  }

  async recordTranscript(_request: TranscriptMirrorRequest): Promise<void> {
    // Generic runtimes do not own a portable transcript store. LocalRuntimeEngineFacade
    // implements the durable mirror used by the installable Pi extension.
  }

  private async projectContext(
    request: ContextRequest,
    mode: "enhance" | "managed-context",
  ): Promise<ContextProjectionResult> {
    const frameworkSource = request.recoveryMessages === undefined
      ? request.messages
      : mode === "managed-context"
        ? [...request.recoveryMessages, ...request.messages]
        : [...request.messages, ...request.recoveryMessages];
    const canonicalSource = request.recoveryMessages === undefined
      ? request.canonicalMessages ?? request.messages
      : mode === "managed-context"
        ? [...request.recoveryMessages, ...request.messages]
        : [...(request.canonicalMessages ?? request.messages), ...request.recoveryMessages];
    const frameworkMessages = frameworkSource.map(toAgentMessage);
    const canonicalMessages = canonicalSource.map(toAgentMessage);
    const model = modelIdentity(request.model);
    const project = await this.projectIdentity(request.cwd);
    const engineRequest: EngineContextRequest = {
      requestId: createId("context"),
      sessionId: request.sessionId,
      threadId: request.threadId,
      mode,
      canonicalMessages,
      frameworkMessages,
      capabilities: PI_HOST_CAPABILITIES,
      ...(request.ownership === undefined ? {} : { ownership: request.ownership }),
      ...(model === undefined ? {} : { model }),
      ...(request.contextWindow === undefined ? {} : { contextWindow: request.contextWindow }),
      metadata: {
        cwd: request.cwd,
        projectId: project.projectId,
        worktreeId: project.worktreeId,
        ...(request.hostBinding === undefined ? {} : {
          namespaceId: request.hostBinding.namespaceId,
          hostType: request.hostBinding.identity.hostType,
        }),
        ...(request.sessionFile === undefined ? {} : { sessionFile: request.sessionFile }),
      },
    };
    const view = await this.runtime.buildContext(engineRequest);
    return {
      messages: view.messages.map(fromAgentMessage),
      source: view.source,
      ...(view.failure === undefined ? {} : { failure: view.failure }),
      ...(view.diagnostics?.ownership === undefined ? {} : { ownership: view.diagnostics.ownership }),
    };
  }

  private projectIdentity(cwd: string): ReturnType<typeof resolveProjectIdentity> {
    let identity = this.projectIdentities.get(cwd);
    if (!identity) {
      identity = resolveProjectIdentity(cwd);
      this.projectIdentities.set(cwd, identity);
    }
    return identity;
  }
}

export function createRuntimeEngineFacade(runtime?: AgentEngramRuntime): RuntimeEngineFacade {
  return new RuntimeEngineFacade(runtime ?? new AgentEngramRuntime());
}

export interface LocalRuntimeEngineFacadeOptions {
  readonly homeDir?: string;
  /** Uses the active/current framework model by default; callers provide the concrete bridge. */
  readonly summarizer?: CompactSummarizer;
  readonly formation?: MemoryFormationPipeline;
  /** Shared model client for transcript Cell boundaries and long-term extraction. */
  readonly llmClient?: LLMChatClient;
  /** Optional current-model bridge injected by tests or advanced Pi hosts. */
  readonly currentModelClient?: PiCurrentModelLLMClient;
  /** Disable only when an installation intentionally uses configured providers exclusively. */
  readonly useHostCurrentModel?: boolean;
  /** Disables environment-backed provider fallback while retaining host-current invocation. */
  readonly useConfiguredProvider?: boolean;
  /** Explicit fallback used only when Pi's active model cannot be invoked. */
  readonly configuredFallbackClient?: LLMChatClient;
  /** Trusted portable namespace override shared by every Pi session in this facade. */
  readonly namespaceId?: string;
  readonly contextMode?: "enhance" | "managed-context";
  readonly toolResultTokenBudget?: number;
  /** Credential-free configured-provider profile loaded from AgentEngram config. */
  readonly providerConfig?: AgentEngramProviderConfig;
  readonly formationMode?: "cell" | "disabled";
  readonly failOpen?: boolean;
}

/** Lazy project-aware local composition used by the installable default extension. */
export class LocalRuntimeEngineFacade implements EngineFacade {
  /** Managed-context requires a model-backed summarizer for compact/collapse. */
  readonly managedContextReady: boolean;
  /** One lazily created local runtime per normalized project id. */
  private readonly runtimes = new Map<string, Promise<LocalAgentEngramRuntime>>();
  /** One shared current-model client used by compact and Cell formation. */
  private readonly llmClient: LLMChatClient | undefined;
  /** Live Pi model bridge; undefined when an explicit Engine client owns all tasks. */
  private readonly currentModelClient: PiCurrentModelLLMClient | undefined;
  /** Provider-neutral policy shared by durable Cell worker model tasks. */
  private readonly taskModelResolver: TaskModelResolver | undefined;
  /** Explicit or default Qwen summarizer used only after managed opt-in. */
  private readonly summarizer: CompactSummarizer | undefined;
  /** Durable source waterlines keyed by canonical project id. */
  private readonly sourceCheckpoints = new Map<string, FileSourceCheckpointRepository>();
  /** Exact durable Pi-session bindings prevent namespace drift after restart. */
  private readonly hostBindings: FileHostBindingRepository;
  /** Latest ownership decision per session/thread for context_inspect. */
  private readonly ownership = new Map<string, import("@agentengram/engine").ContextOwnershipDiagnostic>();

  constructor(private readonly options: LocalRuntimeEngineFacadeOptions = {}) {
    this.hostBindings = new FileHostBindingRepository(join(
      options.homeDir ?? localMemoryHome(),
      "host-bindings",
    ));
    const configuredFallback = options.configuredFallbackClient
      ?? (options.useConfiguredProvider === false ? undefined : defaultLLMClientFromEnvironment(options.providerConfig));
    this.currentModelClient = options.llmClient || options.useHostCurrentModel === false
      ? undefined
      : options.currentModelClient ?? new PiCurrentModelLLMClient({
          ...(configuredFallback === undefined ? {} : { fallback: configuredFallback }),
        });
    // An explicit client always wins. Otherwise Pi's current model is primary
    // and the configured provider remains an observable fallback only.
    this.llmClient = options.llmClient ?? this.currentModelClient ?? configuredFallback;
    const configuredClient = configuredFallback ?? options.llmClient;
    this.taskModelResolver = this.llmClient ? new DefaultTaskModelResolver({
      defaultSource: this.currentModelClient ? "host-current" : "configured-provider",
      ...(this.currentModelClient ? { hostCurrent: {
        resolve: async ({ context }) => {
          const persisted = context.metadata?.modelReference;
          const reference = isHostModelReference(persisted)
            ? persisted
            : this.currentModelClient?.currentModel();
          const client = await this.currentModelClient?.invokeClient(reference);
          return client && reference
            ? {
                client,
                ...(reference.provider === undefined ? {} : { provider: reference.provider }),
                model: reference.model,
              }
            : undefined;
        },
      } } : {}),
      ...(configuredClient ? { configured: {
        resolve: () => ({ client: configuredClient }),
      } } : {}),
      allowConfiguredFallback: true,
    }) : undefined;
    this.summarizer = options.summarizer ?? (this.llmClient ? new LLMCompactSummarizer({ client: this.llmClient }) : undefined);
    this.managedContextReady = this.summarizer !== undefined;
  }

  /** Native Pi tools share the same application service and storage as context hooks. */
  readonly memoryApplication: MemoryApplicationFacade = {
    remember: (input) => this.application(input.projectId).then((value) => value.remember(input)),
    write: (input) => this.application(input.projectId).then((value) => value.write(input)),
    update: (input) => this.application(input.projectId).then((value) => value.update(input)),
    correct: (input) => this.application(input.projectId).then((value) => value.correct(input)),
    search: (input) => this.application(input.projectId).then((value) => value.search(input)),
    read: (scope, id, projectId, partition) => this.application(projectId).then((value) => value.read(scope, id, projectId, partition)),
    forget: (scope, id, projectId, partition) => this.application(projectId).then((value) => value.forget(scope, id, projectId, partition)),
    feedback: (input) => this.application(input.projectId).then((value) => value.feedback(input)),
    inspectContext: (sessionId) => this.inspectContexts(sessionId),
  };

  /** Refreshes the live model/registry pair before model-backed Runtime work. */
  observeHostContext(context: PiContext): void {
    this.currentModelClient?.observe(context);
  }

  /** Loads or atomically creates the trusted Pi-to-portable namespace mapping. */
  async resolveHostBinding(request: {
    readonly cwd: string;
    readonly sessionId: string;
    readonly threadId: string;
  }): Promise<HostBinding> {
    const project = await resolveProjectIdentity(request.cwd);
    const identity = {
      hostType: "pi",
      hostProjectId: project.projectId,
      hostSessionId: request.sessionId,
      hostThreadId: request.threadId,
      worktreeId: project.worktreeId,
    } as const;
    const existing = await this.hostBindings.load(identity);
    if (existing) return existing;
    const binding = createHostBinding(identity, {
      ...(this.options.namespaceId === undefined ? {} : { namespaceId: this.options.namespaceId }),
    });
    await this.hostBindings.save(binding);
    return binding;
  }

  async handleEvent(event: AdapterEvent): Promise<void> {
    return (await this.facade(event.cwd)).handleEvent(event);
  }

  async enhanceContext(request: ContextRequest): Promise<unknown[]> {
    return (await this.facade(request.cwd)).enhanceContext(request);
  }

  async buildManagedContext(request: ContextRequest): Promise<unknown[]> {
    return (await this.facade(request.cwd)).buildManagedContext(request);
  }

  async projectContextView(request: ContextRequest): Promise<ContextProjectionResult> {
    const result = await (await this.facade(request.cwd)).projectContextView(request);
    const decision = result.ownership ?? request.ownership;
    if (decision) this.ownership.set(ownershipKey(request.sessionId, request.threadId), decision);
    return result;
  }

  async compact(request: CompactRequest): Promise<ManagedCompaction | undefined> {
    return (await this.facade(request.cwd)).compact(request);
  }

  async recordTranscript(request: TranscriptMirrorRequest): Promise<void> {
    const identity = await resolveProjectIdentity(request.cwd);
    const runtime = await this.runtime(identity.projectId);
    if (request.branchEntries.length > 0) {
      // Re-resolve from trusted cwd/session/thread instead of accepting a
      // caller-supplied namespace as authority at the persistence boundary.
      const hostBinding = await this.resolveHostBinding(request);
      const checkpointStore = this.sourceCheckpointRepository(identity.projectId);
      const sourceId = piTranscriptSourceId({ ...request, hostBinding }, identity.projectId);
      await ingestPiBranchIncrementally({
        sourceId,
        ...(request.sessionFile === undefined ? {} : { sourceVersion: request.sessionFile }),
        sessionId: request.sessionId,
        threadId: request.threadId,
        branchEntries: request.branchEntries,
        hostBinding,
        checkpoints: checkpointStore,
        append: (entries) => runtime.appendTranscript(entries),
      });
    }
    // Formation must start only after the mirrored transcript is durable. Turn
    // hooks enqueue background work, while lifecycle exits synchronously flush
    // the ambiguous Tail so no final Cell is stranded across sessions/threads.
    if (request.reason === "turn_end" || request.reason === "agent_end") {
      void runtime.scheduleCellFormation({ sessionId: request.sessionId, threadId: request.threadId });
    } else if (request.reason === "session_shutdown" || request.reason === "session_before_tree") {
      await runtime.flushCellFormation({ sessionId: request.sessionId, threadId: request.threadId });
    }
  }

  async recordOwnershipFallback(input: Parameters<NonNullable<EngineFacade["recordOwnershipFallback"]>>[0]): Promise<void> {
    const decision = fallbackContextOwnership(input.ownership, input.reason);
    this.ownership.set(ownershipKey(input.sessionId, input.threadId), decision);
    const identity = await resolveProjectIdentity(input.cwd);
    await (await this.runtime(identity.projectId)).recordContextFallback(
      input.sessionId,
      input.threadId,
      decision,
    );
  }

  /** Closes every lazily created project runtime; primarily used by harnesses. */
  async close(): Promise<void> {
    const runtimes = await Promise.all(this.runtimes.values());
    this.runtimes.clear();
    this.sourceCheckpoints.clear();
    await Promise.all(runtimes.map((runtime) => runtime.close()));
  }

  /** Persist Engine-owned projection state while Pi stores only the durable pointer. */
  async createCheckpoint(
    reason: Parameters<NonNullable<EngineFacade["createCheckpoint"]>>[0],
    context: Parameters<NonNullable<EngineFacade["createCheckpoint"]>>[1],
  ) {
    const identity = await resolveProjectIdentity(context.cwd);
    const runtime = await this.runtime(identity.projectId);
    return runtime.createCheckpoint({
      sessionId: context.sessionId,
      threadId: context.threadId,
      reason,
      ...(context.canonicalMessages === undefined
        ? {}
        : { messages: context.canonicalMessages.map(toAgentMessage) }),
    });
  }

  /** Validate and restore a checkpoint selected from Pi's active branch. */
  async restoreCheckpoint(request: Parameters<NonNullable<EngineFacade["restoreCheckpoint"]>>[0]) {
    if (!request.pointer) return { status: "unavailable" as const };
    const identity = await resolveProjectIdentity(request.cwd);
    const result = await (await this.runtime(identity.projectId)).recover(request.pointer);
    return result.status === "restored"
      ? { status: "restored" as const, messages: result.messages.map(fromAgentMessage) }
      : { status: "unavailable" as const };
  }

  /** Rebuild volatile projection state from Pi's canonical active transcript. */
  async rebuildFromCanonical(request: Parameters<NonNullable<EngineFacade["rebuildFromCanonical"]>>[0]) {
    const identity = await resolveProjectIdentity(request.cwd);
    const result = (await this.runtime(identity.projectId)).rebuildFromCanonical(
      request.sessionId,
      request.threadId,
      request.canonicalMessages.map(toAgentMessage),
    );
    return { status: "rebuilt" as const, messages: result.messages.map(fromAgentMessage) };
  }

  private async facade(cwd: string): Promise<RuntimeEngineFacade> {
    const identity = await resolveProjectIdentity(cwd);
    return new RuntimeEngineFacade(await this.runtime(identity.projectId));
  }

  private async application(projectId = "__global__") {
    return (await this.runtime(projectId)).application;
  }

  private async inspectContexts(sessionId?: string): Promise<unknown> {
    const runtimes = await Promise.all(this.runtimes.values());
    if (sessionId) {
      const diagnostics = await Promise.all(runtimes.map((runtime) => runtime.inspectDiagnostics(sessionId)));
      return {
        available: true,
        projects: diagnostics,
        ownership: [...this.ownership.entries()].filter(([key]) => key.startsWith(`${sessionId}\0`)),
        model: this.currentModelClient?.lastDecision(),
      };
    }
    return {
      available: true,
      projects: await Promise.all(runtimes.map((runtime) => runtime.inspectDiagnostics())),
      ownership: [...this.ownership.entries()],
      model: this.currentModelClient?.lastDecision(),
    };
  }

  private sourceCheckpointRepository(projectId: string): FileSourceCheckpointRepository {
    let repository = this.sourceCheckpoints.get(projectId);
    if (!repository) {
      repository = new FileSourceCheckpointRepository(join(
        this.options.homeDir ?? localMemoryHome(),
        "source-checkpoints",
        createHash("sha256").update(projectId).digest("hex").slice(0, 24),
      ));
      this.sourceCheckpoints.set(projectId, repository);
    }
    return repository;
  }

  private runtime(projectId: string): Promise<LocalAgentEngramRuntime> {
    let runtime = this.runtimes.get(projectId);
    if (!runtime) {
      runtime = LocalAgentEngramRuntime.create({
        homeDir: this.options.homeDir ?? localMemoryHome(),
        projectId,
        ...(this.summarizer === undefined ? {} : { summarizer: this.summarizer }),
        ...(this.options.formation === undefined ? {} : { formation: this.options.formation }),
        ...(this.llmClient === undefined ? {} : { llmClient: this.llmClient }),
        ...(this.taskModelResolver === undefined ? {} : { taskModelResolver: this.taskModelResolver }),
        ...(this.currentModelClient === undefined ? {} : { modelBridge: this.currentModelClient }),
        modelResolutionContext: { hostType: "pi", metadata: { projectId } },
        ...(this.options.formationMode === undefined ? {} : { formationMode: this.options.formationMode }),
        ...(this.options.contextMode === undefined ? {} : { contextMode: this.options.contextMode }),
        ...(this.options.failOpen === undefined ? {} : { failOpen: this.options.failOpen }),
        ...(this.options.toolResultTokenBudget === undefined ? {} : { toolResultTokenBudget: this.options.toolResultTokenBudget }),
      });
      this.runtimes.set(projectId, runtime);
    }
    return runtime;
  }
}

export function createLocalRuntimeEngineFacade(options: LocalRuntimeEngineFacadeOptions = {}): LocalRuntimeEngineFacade {
  return new LocalRuntimeEngineFacade(options);
}

function localMemoryHome(): string {
  if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") {
    return join(process.env.TMPDIR ?? "/tmp", `agentengram-tests-${process.pid}`);
  }
  return process.env.AGENTENGRAM_HOME ?? join(homedir(), ".agentengram");
}

function isHostModelReference(value: unknown): value is import("@agentengram/engine").HostModelReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.model === "string"
    && (record.provider === undefined || typeof record.provider === "string")
    && (record.selectedAt === undefined || typeof record.selectedAt === "string");
}

/** Isolates one Pi branch waterline inside a portable project namespace. */
function piTranscriptSourceId(request: TranscriptMirrorRequest, projectId: string): string {
  const namespaceId = request.hostBinding?.namespaceId ?? projectId;
  return `pi:${namespaceId}:${request.sessionId}:${request.threadId}`;
}

function ownershipKey(sessionId: string, threadId: string): string {
  return `${sessionId}\0${threadId}`;
}

/** Creates the installable adapter's default DashScope/Qwen client outside tests. */
function defaultLLMClientFromEnvironment(provider: AgentEngramProviderConfig = {}): LLMChatClient | undefined {
  // Unit/system tests inject deterministic clients explicitly. Ignoring ambient
  // developer credentials prevents ordinary test runs from making paid calls.
  if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") return undefined;
  const apiKey = process.env[provider.apiKeyEnv ?? "DASHSCOPE_API_KEY"];
  if (!apiKey) return undefined;
  const baseUrl = provider.baseUrl ?? process.env.QWEN_BASE_URL;
  const model = provider.model ?? process.env.QWEN_MODEL;
  return new LLMClient({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
  });
}

interface CompactCapableRuntime {
  compact(request: {
    readonly sessionId: string;
    readonly threadId: string;
    readonly messages: readonly AgentMessage[];
    readonly keepRecentTokens: number;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly messages: readonly AgentMessage[];
    readonly boundary: {
      readonly preCompactTokens: number;
      readonly summaryModel: string;
      readonly [key: string]: unknown;
    };
  }>;
}

/** Structural guard used so adapters can work with both generic and local runtimes. */
function isCompactCapableRuntime(runtime: AgentEngramRuntime): runtime is AgentEngramRuntime & CompactCapableRuntime {
  return "compact" in runtime && typeof (runtime as { compact?: unknown }).compact === "function";
}

/** A local runtime must explicitly expose both compact API and configured summarizer readiness. */
function isManagedContextRuntime(runtime: AgentEngramRuntime): boolean {
  return isCompactCapableRuntime(runtime) &&
    "managedContextReady" in runtime &&
    (runtime as AgentEngramRuntime & { readonly managedContextReady?: unknown }).managedContextReady === true;
}

/** Validates Pi's precomputed compaction boundary and extracts AgentEngram policy inputs. */
function piCompactionPreparation(value: unknown): { firstKeptEntryId: string; keepRecentTokens: number } {
  const preparation = isRecord(value) ? value : {};
  const firstKeptEntryId = typeof preparation.firstKeptEntryId === "string" ? preparation.firstKeptEntryId : undefined;
  if (!firstKeptEntryId) throw new Error("Pi compaction preparation is missing firstKeptEntryId");
  const settings = isRecord(preparation.settings) ? preparation.settings : {};
  // A missing Pi token setting falls back to a conservative protected tail so
  // recent working context remains available after compaction.
  const keepRecentTokens = typeof settings.keepRecentTokens === "number" && Number.isFinite(settings.keepRecentTokens)
    ? Math.max(1, settings.keepRecentTokens)
    : 20_000;
  return { firstKeptEntryId, keepRecentTokens };
}

/** Reads the compact-summary message emitted by Engine after compactTranscript. */
function compactSummaryText(messages: readonly AgentMessage[]): string | undefined {
  const summaryMessage = messages.find((message) => message.metadata?.projection === "compact-summary") ?? messages[0];
  const text = summaryMessage?.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text || undefined;
}

/** Preserve the exact Pi object in metadata; Engine projection works on a neutral view. */
export function toAgentMessage(raw: unknown, index: number): AgentMessage {
  const value = isRecord(raw) ? raw : {};
  const rawRole = typeof value.role === "string" ? value.role : "user";
  const content = toMessageContent(value, rawRole);
  const createdAt = timestampToIso(value.timestamp);
  const neutral = {
    id: messageId(value, index),
    role: normalizeRole(rawRole),
    content,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
  return {
    ...neutral,
    metadata: {
      piRaw: raw,
      piRole: rawRole,
      piNeutralFingerprint: neutralFingerprint(neutral),
    },
  };
}

export function fromAgentMessage(message: AgentMessage): unknown {
  const raw = message.metadata?.piRaw;
  const originalFingerprint = message.metadata?.piNeutralFingerprint;
  // If AgentEngram did not alter the neutral view, return Pi's exact raw object
  // to avoid adapter-induced transcript drift.
  if (raw !== undefined && originalFingerprint === neutralFingerprint(message)) return raw;

  const timestamp = message.createdAt ? Date.parse(message.createdAt) : Date.now();
  if (message.role === "tool") {
    const result = message.content.find((item) => item.type === "tool-result");
    return {
      role: "toolResult",
      toolCallId: result?.type === "tool-result" ? result.toolCallId : message.id,
      toolName: "agentengram",
      content: textBlocks(message.content),
      isError: result?.type === "tool-result" ? result.isError ?? false : false,
      timestamp,
    };
  }
  return {
    role: message.role,
    content: message.content.map(toPiContent),
    timestamp,
  };
}

function toAgentEvent(event: AdapterEvent): AgentEvent | undefined {
  const base = {
    eventId: createEventId(event),
    timestamp: event.occurredAt,
    framework: "pi-mono",
    sessionId: event.sessionId,
    threadId: event.threadId,
    metadata: { piEvent: event.payload, cwd: event.cwd },
  } as const;
  const payload = isRecord(event.payload) ? event.payload : {};

  switch (event.type) {
    case "pi.session_start": {
      const reason = payload.reason;
      if (reason === "resume") return { ...base, eventType: "session.resumed", payload: {} };
      if (reason === "fork") return undefined; // Pi does not expose a trustworthy parent thread id here.
      return {
        ...base,
        eventType: "session.started",
        payload: { reason: reason === "new" ? "new" : "startup" },
      };
    }
    case "pi.session_shutdown":
      return {
        ...base,
        eventType: "session.shutting_down",
        payload: { ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}) },
      };
    case "pi.turn_end":
      return {
        ...base,
        eventType: "turn.completed",
        payload: { turnId: String(payload.turnIndex ?? createId("turn")) },
      };
    case "pi.tool_call":
      if (typeof payload.toolCallId !== "string" || typeof payload.toolName !== "string") return undefined;
      return {
        ...base,
        eventType: "tool.called",
        payload: { toolCallId: payload.toolCallId, toolName: payload.toolName },
      };
    case "pi.tool_result":
      if (typeof payload.toolCallId !== "string") return undefined;
      return payload.isError === true
        ? {
            ...base,
            eventType: "tool.failed",
            payload: { toolCallId: payload.toolCallId, error: toolError(payload) },
          }
        : { ...base, eventType: "tool.completed", payload: { toolCallId: payload.toolCallId } };
    case "pi.session_before_tree": {
      const preparation = isRecord(payload.preparation) ? payload.preparation : {};
      if (typeof preparation.oldLeafId !== "string") return undefined;
      // Pi exposes the old leaf but not a full trusted parent graph in this hook,
      // so AgentEngram records a branch boundary without inventing lineage.
      return {
        ...base,
        eventType: "thread.branching",
        payload: { fromThreadId: preparation.oldLeafId },
      };
    }
    case "pi.session_tree":
      return {
        ...base,
        eventType: "thread.changed",
        payload: { ...(typeof payload.oldLeafId === "string" ? { previousThreadId: payload.oldLeafId } : {}) },
      };
    default:
      return undefined;
  }
}

function toMessageContent(value: Record<string, unknown>, role: string): MessageContent[] {
  if (role === "toolResult") {
    return [{
      type: "tool-result",
      toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : "unknown",
      output: value.content,
      ...(value.isError === true ? { isError: true } : {}),
    }];
  }
  if (typeof value.content === "string") return [{ type: "text", text: value.content }];
  if (!Array.isArray(value.content)) return [];
  const result: MessageContent[] = [];
  for (const item of value.content) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      result.push({ type: "text", text: item.text });
    } else if (item.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string") {
      result.push({
        type: "tool-call",
        id: item.id,
        name: item.name,
        arguments: isRecord(item.arguments) ? item.arguments : {},
      });
    }
  }
  return result;
}

function toPiContent(content: MessageContent): unknown {
  if (content.type === "text") return content;
  if (content.type === "tool-call") {
    return { type: "toolCall", id: content.id, name: content.name, arguments: content.arguments };
  }
  return { type: "text", text: stringify(content.output) };
}

function textBlocks(content: readonly MessageContent[]): Array<{ type: "text"; text: string }> {
  return content.map((item) => ({
    type: "text" as const,
    text: item.type === "text" ? item.text : item.type === "tool-result" ? stringify(item.output) : stringify(item),
  }));
}

function normalizeRole(role: string): AgentMessage["role"] {
  if (role === "system" || role === "user" || role === "assistant") return role;
  return role === "tool" || role === "toolResult" ? "tool" : "user";
}

function messageId(value: Record<string, unknown>, index: number): string {
  if (typeof value.id === "string") return value.id;
  if (typeof value.toolCallId === "string") return `tool-result:${value.toolCallId}`;
  return `pi-message:${index}`;
}

function modelIdentity(model: unknown): string | undefined {
  if (!isRecord(model)) return undefined;
  return typeof model.id === "string" ? model.id : undefined;
}

function timestampToIso(timestamp: unknown): string | undefined {
  if (typeof timestamp !== "number" && typeof timestamp !== "string") return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function toolError(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (Array.isArray(content)) {
    const text = content
      .filter(isRecord)
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");
    if (text) return text;
  }
  return "Pi tool execution failed";
}

function createId(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function createEventId(event: AdapterEvent): string {
  const stablePayload = stableJson(event.payload);
  const digest = createHash("sha256")
    .update(event.sessionId)
    .update("\0")
    .update(event.threadId)
    .update("\0")
    .update(event.type)
    .update("\0")
    .update(stablePayload)
    .digest("hex")
    .slice(0, 20);
  return `pi:${digest}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized ?? String(value);
}

function neutralFingerprint(
  message: Pick<AgentMessage, "id" | "role" | "content" | "createdAt">,
): string {
  return stableJson({
    id: message.id,
    role: message.role,
    content: message.content,
    ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
