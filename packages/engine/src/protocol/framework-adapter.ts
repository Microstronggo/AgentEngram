import type { AgentEvent } from "./agent-event.js";
import type { FrameworkCapabilities } from "./capabilities.js";
import type { ContextView } from "./context-view.js";

/** Minimal lifecycle and context-delivery contract implemented by host adapters. */
export interface FrameworkAdapter<FrameworkContext = unknown> {
  readonly name: string;
  readonly capabilities: FrameworkCapabilities;
  /** Registers host hooks and forwards normalized events through dispatch. */
  start(dispatch: (event: AgentEvent) => Promise<void>): Promise<void>;
  /** Releases adapter-owned hook subscriptions and resources. */
  stop(): Promise<void>;
  /** Delivers a validated Engine view using the host's native context API. */
  applyContext(view: ContextView, context: FrameworkContext): Promise<void>;
}
