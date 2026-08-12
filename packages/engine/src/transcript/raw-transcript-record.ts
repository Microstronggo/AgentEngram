import type { BlobReference, JsonValue } from "../storage/index.js";

/** Durable host-event vocabulary retained before framework-neutral reduction. */
export type RawTranscriptEventType =
  | "session.started"
  | "session.resumed"
  | "session.shutting_down"
  | "message.created"
  | "message.updated"
  | "message.completed"
  | "tool.called"
  | "tool.completed"
  | "tool.failed"
  | "turn.completed"
  | "agent.completed"
  | "compact.completed"
  | "thread.branching"
  | "thread.changed";

/** Optional coarse role attached to raw host facts. */
export type RawTranscriptRole = "system" | "user" | "assistant" | "tool" | "custom";

/** Durable raw fact captured from a host framework event or transcript entry. */
export interface RawTranscriptRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly framework: string;
  readonly frameworkSessionId: string;
  readonly frameworkThreadId?: string;
  readonly frameworkEntryId?: string;
  readonly parentEntryId?: string | null;
  readonly eventType: RawTranscriptEventType;
  readonly role?: RawTranscriptRole;
  readonly timestamp: string;
  readonly content?: JsonValue;
  readonly contentHash: string;
  readonly blobRef?: BlobReference;
  readonly sourceRef: string;
  readonly frameworkSourceRef?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  /** Untrusted original framework payload kept only for audit/debugging. */
  readonly rawFrameworkPayload?: JsonValue;
}
