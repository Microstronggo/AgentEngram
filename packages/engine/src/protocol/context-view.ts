import type { FrameworkCapabilities } from "./capabilities.js";
import type { AgentMessage } from "./message.js";

/** Ownership mode negotiated from the host framework's actual capabilities. */
export type ContextMode = "enhance" | "managed-context";

/** Installation intent before host capabilities select an effective mode. */
export type ContextIntegrationIntent = "auto" | ContextMode;

/** Model-context owner recorded for diagnostics and support tooling. */
export type ContextOwner = "host" | "agentengram";

/** Runtime response when an explicitly managed operation fails after startup. */
export type ManagedFailurePolicy = "strict" | "host-fallback";

/** Stable reasons for an observable context ownership fallback. */
export type ContextFallbackReason =
  | "host-cannot-replace-context"
  | "host-cannot-replace-compaction"
  | "managed-runtime-unavailable"
  | "projection-failed"
  | "compact-failed"
  | "context-invalid";

/** Negotiated ownership state attached to each model-context decision. */
export interface ContextOwnershipDiagnostic {
  readonly requestedMode: ContextIntegrationIntent;
  readonly effectiveMode: ContextMode;
  readonly contextOwner: ContextOwner;
  readonly compactionOwner: ContextOwner;
  readonly failurePolicy: ManagedFailurePolicy;
  readonly fallbackReason?: ContextFallbackReason;
  readonly fallbackCount: number;
}

/** Complete input required to build one model-facing context projection. */
export interface ContextRequest {
  /** Stable id used to correlate projection diagnostics with the host request. */
  readonly requestId: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly mode?: ContextMode;
  /** Full transcript truth available to managed-context projections. */
  readonly canonicalMessages: readonly AgentMessage[];
  /** The context already selected by the framework. Required for fail-open semantics. */
  readonly frameworkMessages: readonly AgentMessage[];
  /** Host guarantees used to reject unsupported ownership modes safely. */
  readonly capabilities: FrameworkCapabilities;
  /** Optional negotiated ownership state propagated into context diagnostics. */
  readonly ownership?: ContextOwnershipDiagnostic;
  readonly model?: string;
  readonly provider?: string;
  readonly contextWindow?: number;
  readonly reservedOutputTokens?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Validated model-context result returned to a framework adapter. */
export interface ContextView {
  readonly requestId: string;
  readonly mode: ContextMode;
  readonly messages: readonly AgentMessage[];
  readonly source: "framework" | "agentengram" | "fail-open";
  readonly failure?: { readonly name: string; readonly message: string };
  readonly diagnostics?: ContextDiagnostics;
}

/** Token and latency accounting for one ordered context projection stage. */
export interface ContextStageDiagnostic {
  readonly stage: string;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly durationMs: number;
}

/** Aggregate diagnostics for explaining one context decision. */
export interface ContextDiagnostics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly limitTokens?: number;
  readonly removedMessageIds?: readonly string[];
  readonly stages: readonly ContextStageDiagnostic[];
  readonly ownership?: ContextOwnershipDiagnostic;
}
