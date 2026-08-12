import type { HostCapabilities } from "./capabilities.js";
import type { HostBinding, HostIdentity } from "./host-identity.js";

/** Host model metadata that can be persisted without provider credentials. */
export interface HostModelReference {
  readonly provider?: string;
  readonly model: string;
  readonly selectedAt?: string;
}

/**
 * Adapter-owned model bridge. The generic client keeps protocol types free of
 * Pi, Codex, or a specific provider SDK.
 */
export interface HostModelBridge<Client = unknown> {
  currentModel(): Promise<HostModelReference | undefined> | HostModelReference | undefined;
  invokeClient(reference?: HostModelReference): Promise<Client | undefined> | Client | undefined;
}

/**
 * Minimal negotiated host integration visible to Engine composition roots.
 * Event registration remains adapter-owned and is intentionally not included.
 */
export interface AgentHostIntegration<Client = unknown> {
  readonly identity: HostIdentity;
  readonly binding: HostBinding;
  readonly capabilities: HostCapabilities;
  readonly modelBridge?: HostModelBridge<Client>;
}
