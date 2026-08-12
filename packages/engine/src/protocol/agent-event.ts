/** Compile-time map from normalized lifecycle names to their minimal payloads. */
interface EventPayloads {
  "session.started": { readonly reason?: "startup" | "new" };
  "session.resumed": { readonly checkpointId?: string };
  "session.forked": { readonly parentThreadId: string };
  "session.shutting_down": { readonly reason?: string };
  "message.user_submitted": { readonly messageId: string };
  "message.started": { readonly messageId: string };
  "message.completed": { readonly messageId: string };
  "turn.started": { readonly turnId: string };
  "turn.completed": { readonly turnId: string };
  "tool.called": { readonly toolCallId: string; readonly toolName: string };
  "tool.completed": { readonly toolCallId: string };
  "tool.failed": { readonly toolCallId: string; readonly error: string };
  "context.requested": { readonly requestId: string };
  "context.projected": { readonly requestId: string; readonly messageCount: number };
  "compaction.requested": { readonly reason: "threshold" | "overflow" | "manual" };
  "compaction.completed": { readonly checkpointId: string };
  "thread.branching": { readonly fromThreadId: string };
  "thread.changed": { readonly previousThreadId?: string };
}

/** Normalized lifecycle event names accepted from every framework adapter. */
export type AgentEventType = keyof EventPayloads;

/** Idempotent framework event routed into one session and thread state machine. */
export type AgentEvent<T extends AgentEventType = AgentEventType> = T extends AgentEventType
  ? Readonly<{
      eventId: string;
      eventType: T;
      timestamp: string;
      framework: string;
      sessionId: string;
      threadId: string;
      parentEventId?: string;
      turnId?: string;
      payload: EventPayloads[T];
      metadata?: Readonly<Record<string, unknown>>;
    }>
  : never;

/** Narrows the AgentEvent union to one lifecycle event name. */
export type EventOf<T extends AgentEventType> = Extract<AgentEvent, { eventType: T }>;
