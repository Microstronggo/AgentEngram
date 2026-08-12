import { sha256, toJsonValue, type HostBinding, type JsonValue, type NormalizedTranscriptEntry, type RawTranscriptRecord } from "@agentengram/engine/adapter";
import { createPiTranscriptSourceRefs } from "./pi-source-ref.js";

export interface PiTranscriptNormalizeInput {
  /** Pi session id that owns the source entry. */
  readonly sessionId: string;
  /** Pi branch/leaf id used as AgentEngram's thread id. */
  readonly threadId: string;
  /** Raw Pi transcript/custom/compaction entry. */
  readonly entry: unknown;
  /** Fallback ordinal used when Pi does not expose a durable entry id. */
  readonly index?: number;
  /** Trusted namespace mapping persisted for cross-adapter traceability. */
  readonly hostBinding?: HostBinding;
}

export interface PiTranscriptNormalized {
  /** Loss-minimized framework payload for future reprocessing. */
  readonly raw: RawTranscriptRecord;
  /** Framework-neutral entry used by context, compaction and formation paths. */
  readonly normalized: NormalizedTranscriptEntry;
}

/** Converts one Pi transcript entry into AgentEngram raw + normalized transcript records. */
export function normalizePiTranscriptEntry(input: PiTranscriptNormalizeInput): PiTranscriptNormalized {
  const entry = isRecord(input.entry) ? input.entry : {};
  const message = isRecord(entry.message) ? entry.message : undefined;
  // Pi entries are not guaranteed to expose the same id shape across message,
  // custom entry and compaction records, so normalization uses a stable fallback chain.
  const entryId = piTranscriptEntryId(input.entry, input.index ?? 0);
  const parentEntryId = stringValue(entry.parentId) ?? stringValue(entry.parentEntryId) ?? null;
  const timestamp = timestampToIso(entry.timestamp ?? message?.timestamp);
  const { sourceRef, frameworkSourceRef } = createPiTranscriptSourceRefs({
    sessionId: input.sessionId,
    threadId: input.threadId,
    entryId,
  });
  const content = entryContent(entry, message);
  const contentHash = sha256(toJsonValue(content));
  const role = rawRole(entry, message);
  const normalizedEntryRole = normalizedRole(entry, message);
  const text = textOf(entry, message);
  const name = toolName(entry, message);
  const callId = toolCallId(entry, message);
  const toolError = isError(entry, message);
  const rawMetadata = withoutUndefined({
    piEntryType: stringValue(entry.type) ?? "message",
    leafId: stringValue(entry.leafId),
    customType: stringValue(entry.customType),
    namespaceId: input.hostBinding?.namespaceId,
    hostType: input.hostBinding?.identity.hostType,
    hostProjectId: input.hostBinding?.identity.hostProjectId,
    worktreeId: input.hostBinding?.identity.worktreeId,
  });
  const normalizedMetadata = withoutUndefined({
    piEntryId: entryId,
    piEntryType: stringValue(entry.type) ?? "message",
    customType: stringValue(entry.customType),
    namespaceId: input.hostBinding?.namespaceId,
    hostType: input.hostBinding?.identity.hostType,
  });
  const raw: RawTranscriptRecord = {
    schemaVersion: 1,
    id: `pi:${input.sessionId}:${input.threadId}:${entryId}:raw`,
    framework: "pi-mono",
    frameworkSessionId: input.sessionId,
    frameworkThreadId: input.threadId,
    frameworkEntryId: entryId,
    parentEntryId,
    eventType: rawEventType(entry, message),
    ...(role === undefined ? {} : { role }),
    timestamp,
    content: toJsonValue(content),
    contentHash,
    sourceRef,
    frameworkSourceRef,
    metadata: rawMetadata,
    rawFrameworkPayload: toJsonValue(input.entry),
  };

  const normalized: NormalizedTranscriptEntry = {
    schemaVersion: 1,
    id: `pi:${input.sessionId}:${input.threadId}:${entryId}:normalized`,
    sessionId: input.sessionId,
    threadId: input.threadId,
    sourceRef,
    frameworkSourceRef,
    kind: normalizedKind(entry, message),
    ...(normalizedEntryRole === undefined ? {} : { role: normalizedEntryRole }),
    ...(text === undefined ? {} : { text }),
    ...(name === undefined ? {} : { toolName: name }),
    ...(callId === undefined ? {} : { toolCallId: callId }),
    ...(toolError === undefined ? {} : { isError: toolError }),
    contentHash,
    createdAt: timestamp,
    parentEntryId,
    metadata: normalizedMetadata,
  };

  return { raw, normalized };
}

/** Normalizes a full Pi branch in entry order while preserving stable fallback ids. */
export function normalizePiBranchTranscript(input: {
  readonly sessionId: string;
  readonly threadId: string;
  readonly branchEntries: readonly unknown[];
  /** Original branch offset retained when only an incremental suffix is normalized. */
  readonly startIndex?: number;
  readonly hostBinding?: HostBinding;
}): readonly PiTranscriptNormalized[] {
  return input.branchEntries.map((entry, index) => normalizePiTranscriptEntry({
    sessionId: input.sessionId,
    threadId: input.threadId,
    entry,
    index: index + (input.startIndex ?? 0),
    ...(input.hostBinding === undefined ? {} : { hostBinding: input.hostBinding }),
  }));
}

/** Stable Pi entry cursor shared by transcript ids and source checkpoints. */
export function piTranscriptEntryId(entryValue: unknown, _index = 0): string {
  const entry = isRecord(entryValue) ? entryValue : {};
  const directId = stringValue(entry.id);
  if (directId) return directId;
  const message = isRecord(entry.message) ? entry.message : undefined;
  return stringValue(message?.id)
    // Pi persisted entries normally have ids. Hashing the complete fallback
    // payload keeps reconciliation stable if an older/custom entry omits one.
    ?? `entry-${sha256(toJsonValue(entryValue)).slice(0, 24)}`;
}

function rawEventType(entry: Record<string, unknown>, message: Record<string, unknown> | undefined): RawTranscriptRecord["eventType"] {
  // Map Pi-specific entry kinds into the small event taxonomy used by portable
  // transcript consumers and future framework adapters.
  if (entry.type === "compaction") return "compact.completed";
  if (entry.type === "branch_summary") return "thread.changed";
  const role = stringValue(message?.role ?? entry.role);
  if (role === "toolResult") return message?.isError === true ? "tool.failed" : "tool.completed";
  return "message.created";
}

function normalizedKind(entry: Record<string, unknown>, message: Record<string, unknown> | undefined): NormalizedTranscriptEntry["kind"] {
  // Prefer explicit Pi entry types first, then infer tool-call/tool-result from
  // message role and content because Pi's raw shape varies by hook surface.
  if (entry.type === "compaction") return "compaction";
  if (entry.type === "branch_summary") return "branch_summary";
  if (entry.type === "custom" || entry.type === "custom_message") return "custom";
  const role = stringValue(message?.role ?? entry.role);
  if (role === "toolResult") return "tool_result";
  const content = Array.isArray(message?.content) ? message.content : Array.isArray(entry.content) ? entry.content : [];
  if (content.some((item) => isRecord(item) && item.type === "toolCall")) return "tool_call";
  return "message";
}

function rawRole(entry: Record<string, unknown>, message: Record<string, unknown> | undefined): RawTranscriptRecord["role"] | undefined {
  const role = stringValue(message?.role ?? entry.role);
  if (role === "system" || role === "user" || role === "assistant") return role;
  if (role === "tool" || role === "toolResult") return "tool";
  if (role === "custom" || entry.type === "custom" || entry.type === "custom_message") return "custom";
  return undefined;
}

function normalizedRole(entry: Record<string, unknown>, message: Record<string, unknown> | undefined): string | undefined {
  return stringValue(message?.role ?? entry.role ?? entry.type);
}

function entryContent(entry: Record<string, unknown>, message: Record<string, unknown> | undefined): unknown {
  // Keep the highest-fidelity content available. Compaction and branch summary
  // records do not look like ordinary messages, so reconstruct a compact object.
  if (message) return message.content ?? message;
  if (entry.type === "compaction") return { summary: entry.summary, tokensBefore: entry.tokensBefore, firstKeptEntryId: entry.firstKeptEntryId };
  if (entry.type === "branch_summary") return { summary: entry.summary, fromId: entry.fromId };
  return entry.content ?? entry.data ?? entry;
}

function textOf(entry: Record<string, unknown>, message: Record<string, unknown> | undefined): string | undefined {
  if (entry.type === "compaction") return stringValue(entry.summary);
  if (entry.type === "branch_summary") return stringValue(entry.summary);
  const value = entryContent(entry, message);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .filter(isRecord)
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");
    return text || undefined;
  }
  return undefined;
}

function toolCallId(entry: Record<string, unknown>, message: Record<string, unknown> | undefined): string | undefined {
  const direct = stringValue(message?.toolCallId ?? entry.toolCallId);
  if (direct) return direct;
  const content = Array.isArray(message?.content) ? message.content : Array.isArray(entry.content) ? entry.content : [];
  const call = content.find((item) => isRecord(item) && item.type === "toolCall" && typeof item.id === "string");
  return isRecord(call) ? stringValue(call.id) : undefined;
}

function toolName(entry: Record<string, unknown>, message: Record<string, unknown> | undefined): string | undefined {
  const direct = stringValue(message?.toolName ?? entry.toolName);
  if (direct) return direct;
  const content = Array.isArray(message?.content) ? message.content : Array.isArray(entry.content) ? entry.content : [];
  const call = content.find((item) => isRecord(item) && item.type === "toolCall" && typeof item.name === "string");
  return isRecord(call) ? stringValue(call.name) : undefined;
}

function isError(entry: Record<string, unknown>, message: Record<string, unknown> | undefined): boolean | undefined {
  const value = message?.isError ?? entry.isError;
  return typeof value === "boolean" ? value : undefined;
}

function timestampToIso(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return new Date(0).toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function withoutUndefined(value: Record<string, unknown>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = toJsonValue(item);
  }
  return result;
}
