/** Host feature matrix used to gate context ownership and lifecycle behavior. */
export interface FrameworkCapabilities {
  /** The host offers a point where additional or replacement context can be supplied. */
  readonly contextHook: boolean;
  /** The hook can replace, rather than only append to, the complete model context. */
  readonly replaceContext: boolean;
  /** The host exposes compaction lifecycle events. */
  readonly compactionHook: boolean;
  /** AgentEngram may return the compacted history or summary consumed by the host. */
  readonly replaceCompaction: boolean;
  readonly sessionLifecycle: boolean;
  readonly threadLifecycle: boolean;
  readonly toolLifecycle: boolean;
  readonly persistentCustomEntries: boolean;
}

/** Framework-neutral transcript transport exposed by one Agent host. */
export type HostTranscriptMode = "event-stream" | "branch" | "jsonl-rollout";

/** Lifetime of the process in which an adapter callback executes. */
export type HostRuntimeLifetime = "long-lived" | "command-hook";

/**
 * Extended host capability declaration used to negotiate optional Runtime
 * ownership without coupling Engine to a concrete framework SDK.
 */
export interface HostCapabilities extends FrameworkCapabilities {
  /** Source shape used by the adapter to mirror portable transcript evidence. */
  readonly transcriptMode: HostTranscriptMode;
  /** True only when the adapter can invoke, not merely name, the active host model. */
  readonly canInvokeCurrentModel: boolean;
  /** Distinguishes embedded workers from adapters that exit after every event. */
  readonly runtimeLifetime: HostRuntimeLifetime;
  /** Whether parent/child Agent lifecycle and lineage are observable. */
  readonly supportsSubagents: boolean;
  /** Optional upstream schema/version used by adapter conformance diagnostics. */
  readonly schemaVersion?: string;
}

/** Safe capability baseline for unknown or MCP-only hosts. */
export const NO_FRAMEWORK_CAPABILITIES: FrameworkCapabilities = Object.freeze({
  contextHook: false,
  replaceContext: false,
  compactionHook: false,
  replaceCompaction: false,
  sessionLifecycle: false,
  threadLifecycle: false,
  toolLifecycle: false,
  persistentCustomEntries: false,
});

/** Safe capability baseline for an unknown or explicit-tool-only host. */
export const NO_HOST_CAPABILITIES: HostCapabilities = Object.freeze({
  ...NO_FRAMEWORK_CAPABILITIES,
  transcriptMode: "event-stream",
  canInvokeCurrentModel: false,
  runtimeLifetime: "command-hook",
  supportsSubagents: false,
});
