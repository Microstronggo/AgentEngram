import type {
  CheckpointPointerV1,
  MemoryRecord,
  MemoryPartition,
  MemoryScope,
  MemoryWriteCommand,
  MemoryWriteResult,
  RememberInput,
  RecallAudience,
  ContextOwnershipDiagnostic,
  ContextFallbackReason,
  HostBinding,
  ManagedFailurePolicy,
} from "@agentengram/engine";
import type { PiContext } from "./pi-types.js";

/** User-facing integration intent. Auto deliberately preserves host ownership. */
export type IntegrationMode = "auto" | "enhance" | "managed-context";

/** Concrete mode passed into Engine after adapter capability resolution. */
export type ResolvedIntegrationMode = Exclude<IntegrationMode, "auto">;

export type CheckpointReason =
  | "periodic"
  | "pre_compact"
  | "post_compact"
  | "tree_change"
  | "shutdown";

export type PiAgentEngramCheckpointV1 = CheckpointPointerV1;

export const CHECKPOINT_CUSTOM_TYPE = "agentengram.checkpoint.v1";

export interface AdapterEvent {
  type: string;
  occurredAt: string;
  sessionFile?: string;
  sessionId: string;
  threadId: string;
  cwd: string;
  payload: unknown;
}

export interface ContextRequest {
  mode: ResolvedIntegrationMode;
  messages: unknown[];
  canonicalMessages?: unknown[];
  /** Restored context is a stable segment between canonical history and per-turn recall. */
  recoveryMessages?: unknown[];
  cwd: string;
  sessionFile?: string;
  sessionId: string;
  threadId: string;
  model?: unknown;
  /** Active model context capacity reported by Pi, when it is known. */
  contextWindow?: number;
  /** Trusted portable namespace mapping derived from Pi ExtensionContext. */
  hostBinding?: HostBinding;
  /** Negotiated context owner propagated into Engine diagnostics. */
  ownership?: ContextOwnershipDiagnostic;
}

export interface RecoveryRequest {
  reason: "session_start" | "tree_change";
  pointer?: PiAgentEngramCheckpointV1;
  canonicalMessages: unknown[];
  branchEntries: unknown[];
  cwd: string;
  sessionId: string;
  threadId: string;
  sessionFile?: string;
}

export interface RecoveryResult {
  status: "restored" | "rebuilt" | "unavailable";
  /** Optional stable context segment to deliver on subsequent context hooks. */
  messages?: unknown[];
}

export interface CompactRequest {
  mode: "managed-context";
  preparation: unknown;
  branchEntries: unknown[];
  customInstructions?: string;
  signal: AbortSignal;
  cwd: string;
  sessionId: string;
  threadId: string;
  canonicalMessages: unknown[];
  sessionFile?: string;
  model?: unknown;
}

export interface TranscriptMirrorRequest {
  cwd: string;
  sessionId: string;
  threadId: string;
  sessionFile?: string;
  branchEntries: readonly unknown[];
  /** Trusted host binding used to isolate the source checkpoint. */
  hostBinding?: HostBinding;
  reason:
    | "context"
    | "session_shutdown"
    | "session_before_compact"
    | "session_compact"
    | "session_before_tree"
    | "session_tree"
    | "tool_call"
    | "tool_result"
    | "turn_end"
    | "agent_end";
}

export interface ManagedCompaction {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
}

/**
 * Temporary anti-corruption boundary between the Pi adapter and Engine.
 * Engine owns every memory decision; the adapter owns only Pi lifecycle wiring.
 */
export interface EngineFacade {
  /** Explicitly set false when the facade cannot provide an atomic managed-context lifecycle. */
  managedContextReady?: boolean;
  /** Optional application service exposed by a composed local Engine runtime. */
  memoryApplication?: MemoryApplicationFacade;
  /** Observes Pi's active model/registry without retaining provider credentials. */
  observeHostContext?(context: PiContext): void;
  /** Resolves a durable host-to-portable binding from trusted adapter identity. */
  resolveHostBinding?(request: {
    readonly cwd: string;
    readonly sessionId: string;
    readonly threadId: string;
  }): HostBinding | Promise<HostBinding>;
  handleEvent?(event: AdapterEvent): void | Promise<void>;
  enhanceContext?(request: ContextRequest): unknown[] | undefined | Promise<unknown[] | undefined>;
  buildManagedContext?(request: ContextRequest): unknown[] | undefined | Promise<unknown[] | undefined>;
  /** Optional diagnostic-preserving projection path used by the local runtime. */
  projectContextView?(request: ContextRequest): ContextProjectionResult | Promise<ContextProjectionResult>;
  compact?(request: CompactRequest): ManagedCompaction | undefined | Promise<ManagedCompaction | undefined>;
  recordTranscript?(request: TranscriptMirrorRequest): void | Promise<void>;
  restoreCheckpoint?(request: RecoveryRequest): RecoveryResult | undefined | Promise<RecoveryResult | undefined>;
  rebuildFromCanonical?(request: RecoveryRequest): RecoveryResult | undefined | Promise<RecoveryResult | undefined>;
  createCheckpoint?(
    reason: CheckpointReason,
    context: {
      cwd: string;
      sessionId: string;
      threadId: string;
      canonicalMessages?: unknown[];
      sessionFile?: string;
      payload?: unknown;
    },
  ): PiAgentEngramCheckpointV1 | undefined | Promise<PiAgentEngramCheckpointV1 | undefined>;
  /** Records a host fallback that occurs outside Engine's context pipeline. */
  recordOwnershipFallback?(input: {
    readonly cwd: string;
    readonly sessionId: string;
    readonly threadId: string;
    readonly reason: ContextFallbackReason;
    readonly ownership: ContextOwnershipDiagnostic;
  }): void | Promise<void>;
}

/** Complete model-facing projection with ownership/failure diagnostics intact. */
export interface ContextProjectionResult {
  readonly messages: unknown[];
  readonly source: "framework" | "agentengram" | "fail-open";
  readonly failure?: { readonly name: string; readonly message: string };
  readonly ownership?: ContextOwnershipDiagnostic;
}

/**
 * Shared application boundary used by Pi native tools and the MCP adapter.
 * Implementations normally delegate directly to Engine's MemoryApplicationService.
 */
export interface MemoryApplicationFacade {
  remember(input: RememberInput): Promise<MemoryRecord>;
  write(input: MemoryWriteCommand): Promise<MemoryWriteResult>;
  update(input: MemoryWriteCommand & { readonly targetMemoryId: string }): Promise<MemoryWriteResult>;
  correct(input: MemoryWriteCommand & { readonly targetMemoryId: string }): Promise<MemoryWriteResult>;
  search(input: {
    readonly text: string;
    readonly projectId?: string;
    readonly scope?: MemoryScope;
    readonly limit?: number;
    readonly audience?: RecallAudience;
  }): unknown | Promise<unknown>;
  read(scope: MemoryScope, id: string, projectId?: string, partition?: MemoryPartition): Promise<MemoryRecord | null>;
  forget(scope: MemoryScope, id: string, projectId?: string, partition?: MemoryPartition): Promise<boolean>;
  feedback(input: Omit<RememberInput, "type" | "kind"> & { readonly targetMemoryId?: string }): Promise<MemoryRecord>;
  inspectContext(sessionId?: string): unknown | Promise<unknown>;
}

export interface AdapterOptions {
  engine: EngineFacade;
  memoryApplication?: MemoryApplicationFacade;
  mode?: IntegrationMode;
  notifyOnError?: boolean;
  /** Runtime response after an explicitly managed operation fails. */
  managedFailurePolicy?: ManagedFailurePolicy;
  /** Trusted portable namespace override; never accepted from model tool input. */
  namespaceId?: string;
  /** Stable identities required before model-facing global scopes are exposed. */
  scopeIdentity?: ModelFacingScopeIdentity;
}

/** Trusted adapter configuration for non-project memory visibility scopes. */
export interface ModelFacingScopeIdentity {
  readonly userId?: string;
  readonly agentId?: string;
  readonly teamId?: string;
}
