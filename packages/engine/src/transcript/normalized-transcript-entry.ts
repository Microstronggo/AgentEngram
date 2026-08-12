import type { BlobReference, JsonValue } from "../storage/index.js";

/** Framework-neutral transcript categories consumed by context and formation. */
export type NormalizedTranscriptKind =
  | "message"
  | "tool_call"
  | "tool_result"
  | "compaction"
  | "branch_summary"
  | "lifecycle"
  | "custom";

/** Portable, loss-reduced transcript projection derived from one raw framework fact. */
export interface NormalizedTranscriptEntry {
  readonly schemaVersion: 1;
  /** Stable Engine id used as the Cell Formation cursor. */
  readonly id: string;
  readonly sessionId: string;
  readonly threadId: string;
  /** AgentEngram URI pointing back to the canonical transcript fact. */
  readonly sourceRef: string;
  readonly frameworkSourceRef?: string;
  readonly kind: NormalizedTranscriptKind;
  readonly role?: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  /** Hash of complete content, including content moved to BlobStore. */
  readonly contentHash: string;
  readonly blobRef?: BlobReference;
  readonly createdAt: string;
  readonly parentEntryId?: string | null;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}
