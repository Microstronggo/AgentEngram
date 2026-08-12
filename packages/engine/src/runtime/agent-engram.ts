import { ContextPipeline } from "../context/index.js";
import type { AgentEvent, ContextRequest, ContextView } from "../protocol/index.js";
import { EventRouter, type DispatchResult } from "./event-router.js";

/** Injectable framework-neutral pipelines used by the lightweight runtime. */
export interface AgentEngramRuntimeOptions {
  readonly context?: ContextPipeline;
  readonly events?: EventRouter;
}

/** Small composition root used by framework adapters. */
export class AgentEngramRuntime {
  /** Ordered context projection pipeline shared by framework adapters. */
  readonly context: ContextPipeline;
  /** Idempotent normalized lifecycle event router. */
  readonly events: EventRouter;

  constructor(options: AgentEngramRuntimeOptions = {}) {
    this.context = options.context ?? new ContextPipeline();
    this.events = options.events ?? new EventRouter();
  }

  /** Routes one normalized host event with event-id idempotence. */
  handle(event: AgentEvent): Promise<DispatchResult> {
    return this.events.dispatch(event);
  }

  /** Builds one capability-gated, validated model-context view. */
  buildContext(request: ContextRequest): Promise<ContextView> {
    return this.context.build(request);
  }

  /** Read-only operational view used by native tools and adapter diagnostics. */
  inspectDiagnostics(sessionId?: string): unknown | Promise<unknown> {
    return sessionId
      ? { available: true, session: this.events.session(sessionId)?.snapshot() ?? null }
      : { available: true, sessions: this.events.snapshots() };
  }
}
