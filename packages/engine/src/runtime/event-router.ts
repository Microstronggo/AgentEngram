import type { AgentEvent } from "../protocol/index.js";
import { SessionRuntime } from "./session-runtime.js";

/** Side-effect hook invoked before an event is committed to session state. */
export type AgentEventHandler = (event: AgentEvent, session: SessionRuntime) => void | Promise<void>;

/** Indicates whether a normalized event changed runtime state. */
export interface DispatchResult {
  readonly applied: boolean;
  readonly reason?: "duplicate";
}

/** Routes normalized lifecycle events to per-session state with idempotent delivery. */
export class EventRouter {
  /** Live state machines keyed by framework session id. */
  private readonly sessions = new Map<string, SessionRuntime>();
  /** Successfully applied event ids used to make adapter retries idempotent. */
  private readonly processedEventIds = new Set<string>();
  /** Side-effect handlers that must succeed before an event is committed. */
  private readonly handlers: readonly AgentEventHandler[];

  constructor(handlers: readonly AgentEventHandler[] = []) {
    this.handlers = handlers;
  }

  /** Applies one event exactly once; handler failures leave it retryable. */
  async dispatch(event: AgentEvent): Promise<DispatchResult> {
    if (this.processedEventIds.has(event.eventId)) {
      return { applied: false, reason: "duplicate" };
    }

    const session = this.sessions.get(event.sessionId)
      ?? new SessionRuntime(event.sessionId, event.threadId);

    // Apply and mark only after handlers succeed, so a failed delivery remains retryable.
    for (const handler of this.handlers) await handler(event, session);
    session.apply(event);
    this.sessions.set(event.sessionId, session);
    this.processedEventIds.add(event.eventId);
    return { applied: true };
  }

  /** Returns the live state machine for operational inspection. */
  session(sessionId: string): SessionRuntime | undefined {
    return this.sessions.get(sessionId);
  }

  /** Returns payload-free snapshots for every observed host session. */
  snapshots(): readonly import("./session-runtime.js").SessionSnapshot[] {
    return [...this.sessions.values()].map((session) => session.snapshot());
  }
}
