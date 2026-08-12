import type { AgentEvent } from "../protocol/index.js";

/** Coarse lifecycle phase retained without storing framework payloads. */
export type SessionStatus = "idle" | "active" | "shutting-down";

/** Read-only operational counters for one framework session. */
export interface SessionSnapshot {
  readonly sessionId: string;
  readonly activeThreadId: string;
  readonly status: SessionStatus;
  readonly lastEventId?: string;
  readonly eventCount: number;
  readonly completedTurns: number;
  readonly completedTools: number;
  readonly failedTools: number;
}

/** Minimal framework-neutral lifecycle state for one Agent session. */
export class SessionRuntime {
  /** Stable framework session identifier. */
  readonly sessionId: string;
  /** Durable branch anchor, not the host's moving append cursor. */
  private activeThreadId: string;
  /** Current lifecycle phase exposed through context inspection. */
  private status: SessionStatus = "idle";
  /** Last committed event, useful for diagnostics and replay inspection. */
  private lastEventId: string | undefined;
  /** Monotonic counters describe observed work without retaining payloads. */
  private eventCount = 0;
  /** Number of successfully completed agent turns. */
  private completedTurns = 0;
  /** Number of successful tool executions. */
  private completedTools = 0;
  /** Number of failed tool executions. */
  private failedTools = 0;

  constructor(sessionId: string, threadId: string) {
    this.sessionId = sessionId;
    this.activeThreadId = threadId;
  }

  /** Applies a previously deduplicated event to lifecycle state and counters. */
  apply(event: AgentEvent): void {
    if (event.sessionId !== this.sessionId) {
      throw new Error(`Event session ${event.sessionId} does not match ${this.sessionId}`);
    }

    this.eventCount += 1;
    this.lastEventId = event.eventId;
    this.activeThreadId = event.threadId;

    switch (event.eventType) {
      case "session.started":
      case "session.resumed":
      case "session.forked":
        this.status = "active";
        break;
      case "session.shutting_down":
        this.status = "shutting-down";
        break;
      case "turn.completed":
        this.completedTurns += 1;
        break;
      case "tool.completed":
        this.completedTools += 1;
        break;
      case "tool.failed":
        this.failedTools += 1;
        break;
    }
  }

  /** Returns a payload-free copy suitable for diagnostics and MCP inspection. */
  snapshot(): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      activeThreadId: this.activeThreadId,
      status: this.status,
      ...(this.lastEventId === undefined ? {} : { lastEventId: this.lastEventId }),
      eventCount: this.eventCount,
      completedTurns: this.completedTurns,
      completedTools: this.completedTools,
      failedTools: this.failedTools,
    };
  }
}
