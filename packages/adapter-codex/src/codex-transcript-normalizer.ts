import { open, realpath, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import {
  sha256,
  toJsonValue,
  type JsonValue,
  type HostBinding,
  type NormalizedTranscriptEntry,
  type RawTranscriptRecord,
  type SourceCheckpoint,
  type TranscriptAppendInput,
} from "@agentengram/engine/adapter";
import type { CodexHookInput } from "./types.js";

export interface CodexRolloutNormalizeInput {
  readonly sessionId: string;
  readonly threadId: string;
  readonly line: unknown;
  readonly lineNumber: number;
  readonly currentTurnId?: string;
  /** Stable file incarnation used to make byte provenance replacement-safe. */
  readonly sourceVersion?: string;
  /** Absolute byte offset where this JSONL row begins. */
  readonly byteOffset?: number;
  /** Trusted portable namespace and host lineage attached by the adapter. */
  readonly hostBinding?: HostBinding;
}

export interface CodexRolloutLine {
  readonly raw: RawTranscriptRecord;
  readonly normalized?: NormalizedTranscriptEntry;
  readonly turnId?: string;
}

/** Incremental rollout batch plus the waterline committed after transcript persistence. */
export interface CodexRolloutReadResult {
  readonly records: readonly TranscriptAppendInput[];
  readonly checkpoint?: SourceCheckpoint;
  /** True when file replacement or truncation invalidated the previous parser state. */
  readonly reset: boolean;
}

/** Minimal positional reader used to make short-read behavior independently testable. */
export interface PositionalFileReader {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
}

/** Reads the valid JSONL prefix; an incomplete crash tail is retried on the next hook. */
export async function readCodexRollout(input: {
  readonly path: string;
  readonly sessionId: string;
  readonly threadId: string;
}): Promise<readonly TranscriptAppendInput[]> {
  return (await readCodexRolloutIncremental(input)).records;
}

/** Creates the repository key independently from the current file incarnation. */
export async function codexRolloutSourceId(input: {
  readonly path: string;
  readonly sessionId: string;
  readonly threadId: string;
}): Promise<string> {
  const canonical = await realpath(input.path).catch(() => resolve(input.path));
  return `codex-rollout:${sha256(`${canonical}\0${input.sessionId}\0${input.threadId}`)}`;
}

/**
 * Reads only bytes appended after the durable source checkpoint. Incomplete
 * UTF-8/JSON bytes are base64 encoded in the next checkpoint, so a command hook
 * never advances past evidence it has not parsed and persisted.
 */
export async function readCodexRolloutIncremental(input: {
  readonly path: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly checkpoint?: SourceCheckpoint;
  readonly hostBinding?: HostBinding;
}): Promise<CodexRolloutReadResult> {
  const sourceId = await codexRolloutSourceId(input);
  const file = await open(input.path, "r").catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (!file) return { records: [], reset: false };
  try {
    const metadata = await file.stat();
    const sourceVersion = `${metadata.dev}:${metadata.ino}`;
    const candidate = input.checkpoint?.sourceId === sourceId && input.checkpoint.cursorType === "byte-offset"
      ? input.checkpoint
      : undefined;
    const candidateOffset = parseByteOffset(candidate?.cursorValue);
    const anchorMatches = candidate
      ? await checkpointAnchorMatches(file, candidate, candidateOffset, metadata.size)
      : true;
    const reset = Boolean(candidate && (
      candidate.sourceVersion !== sourceVersion
      || candidateOffset > metadata.size
      || !anchorMatches
    ));
    const checkpoint = reset ? undefined : candidate;
    const offset = checkpoint ? candidateOffset : 0;
    const priorTail = decodePartialTail(checkpoint?.partialTail);
    const appendedRead = await readFileRangeFully(file, offset, Math.max(0, metadata.size - offset));
    const appended = appendedRead.bytes;
    const observedEndOffset = appendedRead.endOffset;
    const bytes = Buffer.concat([priorTail, appended]);
    const baseOffset = offset - priorTail.length;
    let currentTurnId = parserText(checkpoint, "currentTurnId");
    let lineNumber = parserInteger(checkpoint, "lineNumber");
    let start = 0;
    const records: TranscriptAppendInput[] = [];

    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== 0x0a) continue;
      const end = index > start && bytes[index - 1] === 0x0d ? index - 1 : index;
      const textLine = bytes.subarray(start, end).toString("utf8");
      lineNumber++;
      if (textLine.trim()) {
        let line: unknown;
        try {
          line = JSON.parse(textLine);
        } catch {
          // Retain the malformed row and every later byte. A concurrent writer
          // may have exposed a temporary suffix, and skipping it would lose truth.
          lineNumber--;
          break;
        }
        const result = normalizeCodexRolloutLine({
          sessionId: input.sessionId,
          threadId: input.threadId,
          line,
          lineNumber,
          sourceVersion,
          byteOffset: baseOffset + start,
          ...(input.hostBinding ? { hostBinding: input.hostBinding } : {}),
          ...(currentTurnId ? { currentTurnId } : {}),
        });
        if (result.turnId) currentTurnId = result.turnId;
        records.push(result.normalized ? { raw: result.raw, normalized: result.normalized } : { raw: result.raw });
      }
      start = index + 1;
    }

    const partialTail = bytes.subarray(start);
    const nextCheckpoint: SourceCheckpoint = {
      schemaVersion: 1,
      sourceId,
      sourceVersion,
      cursorType: "byte-offset",
      // Commit only bytes actually returned by the filesystem. A positional
      // read may legally be short, especially when a writer truncates the file
      // concurrently, and advancing to stat.size would lose unread evidence.
      cursorValue: String(observedEndOffset),
      ...(partialTail.length > 0 ? { partialTail: partialTail.toString("base64") } : {}),
      parserState: {
        lineNumber,
        ...(reset ? { sourceReset: true } : {}),
        ...(currentTurnId ? { currentTurnId } : {}),
        ...await sourceAnchorState(file, observedEndOffset),
        ...(input.hostBinding ? {
          namespaceId: input.hostBinding.namespaceId,
          hostType: input.hostBinding.identity.hostType,
        } : {}),
      },
      updatedAt: new Date().toISOString(),
    };
    return { records, checkpoint: nextCheckpoint, reset };
  } finally {
    await file.close();
  }
}

/**
 * Reads a positional range until it is full or the filesystem reports EOF.
 * Node does not guarantee that one FileHandle.read call fills the requested
 * buffer, so callers must commit only `endOffset` rather than a prior stat size.
 */
export async function readFileRangeFully(
  file: PositionalFileReader,
  position: number,
  length: number,
): Promise<{ readonly bytes: Buffer; readonly endOffset: number }> {
  if (!Number.isSafeInteger(position) || position < 0) throw new Error("file read position must be a non-negative integer");
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("file read length must be a non-negative integer");
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await file.read(buffer, total, length - total, position + total);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length - total) {
      throw new Error("filesystem returned an invalid byte count");
    }
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return { bytes: buffer.subarray(0, total), endOffset: position + total };
}

const SOURCE_ANCHOR_BYTES = 128;

/** Detects same-inode truncate/regrow by validating bytes immediately before the cursor. */
async function checkpointAnchorMatches(
  file: FileHandle,
  checkpoint: SourceCheckpoint,
  cursor: number,
  currentSize: number,
): Promise<boolean> {
  const length = parserInteger(checkpoint, "anchorLength");
  const expectedHash = parserText(checkpoint, "anchorHash");
  if (length === 0 || !expectedHash) return true;
  if (length > cursor || cursor > currentSize) return false;
  const read = await readFileRangeFully(file, cursor - length, length);
  return read.bytes.length === length && sha256(read.bytes.toString("base64")) === expectedHash;
}

/** Captures a small content anchor without persisting raw transcript bytes in checkpoint metadata. */
async function sourceAnchorState(file: FileHandle, cursor: number): Promise<Record<string, JsonValue>> {
  const length = Math.min(SOURCE_ANCHOR_BYTES, cursor);
  if (length === 0) return {};
  const read = await readFileRangeFully(file, cursor - length, length);
  if (read.bytes.length !== length) return {};
  return {
    anchorLength: length,
    anchorHash: sha256(read.bytes.toString("base64")),
  };
}

/** Converts one Codex rollout row into loss-minimized raw truth plus an optional model-neutral view. */
export function normalizeCodexRolloutLine(input: CodexRolloutNormalizeInput): CodexRolloutLine {
  const line = isRecord(input.line) ? input.line : {};
  const payload = isRecord(line.payload) ? line.payload : {};
  const topType = stringValue(line.type) ?? "unknown";
  const payloadType = stringValue(payload.type);
  const timestamp = timestampToIso(line.timestamp);
  const turnId = topType === "turn_context"
    ? stringValue(payload.turn_id) ?? input.currentTurnId
    : input.currentTurnId;
  const semanticId = semanticEntryId(payload, topType, input.lineNumber, turnId);
  const refs = codexSourceRefs(input.sessionId, input.threadId, semanticId);
  const content = toJsonValue(input.line);
  const contentHash = sha256(content);
  const role = rawRole(payload);
  const raw: RawTranscriptRecord = {
    schemaVersion: 1,
    id: input.sourceVersion === undefined || input.byteOffset === undefined
      ? `codex:${input.sessionId}:${input.threadId}:line-${input.lineNumber}:raw`
      : `codex:${input.sessionId}:${input.threadId}:${input.sourceVersion}:byte-${input.byteOffset}:raw`,
    framework: "codex",
    frameworkSessionId: input.sessionId,
    frameworkThreadId: input.threadId,
    frameworkEntryId: semanticId,
    eventType: rawEventType(topType, payloadType),
    ...(role ? { role } : {}),
    timestamp,
    content,
    contentHash,
    sourceRef: input.sourceVersion === undefined || input.byteOffset === undefined
      ? refs.sourceRef
      : `agentengram://transcript/codex/${encodeURIComponent(input.sessionId)}/${encodeURIComponent(input.threadId)}/${encodeURIComponent(input.sourceVersion)}/${input.byteOffset}`,
    frameworkSourceRef: input.sourceVersion === undefined || input.byteOffset === undefined
      ? refs.frameworkSourceRef
      : `codex://rollout/${encodeURIComponent(input.sourceVersion)}/${input.byteOffset}`,
    metadata: withoutUndefined({
      codexRolloutType: topType,
      codexPayloadType: payloadType,
      lineNumber: input.lineNumber,
      byteOffset: input.byteOffset,
      sourceVersion: input.sourceVersion,
      turnId,
      namespaceId: input.hostBinding?.namespaceId,
      hostType: input.hostBinding?.identity.hostType,
      parentThreadId: input.hostBinding?.identity.parentThreadId,
      agentId: input.hostBinding?.identity.agentId,
    }),
    rawFrameworkPayload: content,
  };
  const normalized = normalizedEntry({
    sessionId: input.sessionId,
    threadId: input.threadId,
    topType,
    payload,
    ...(payloadType ? { payloadType } : {}),
    semanticId,
    timestamp,
    ...(turnId ? { turnId } : {}),
    refs,
    ...(input.hostBinding ? { hostBinding: input.hostBinding } : {}),
  });
  return { raw, ...(normalized ? { normalized } : {}), ...(turnId ? { turnId } : {}) };
}

/** Creates a stable hook-time message before Codex has appended it to the rollout. */
export function normalizeCodexHookMessage(input: {
  readonly sessionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp?: string;
  readonly hostBinding?: HostBinding;
}): TranscriptAppendInput {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const semanticId = messageSemanticId(input.turnId, input.role, input.text);
  const refs = codexSourceRefs(input.sessionId, input.threadId, semanticId);
  const content = toJsonValue({ role: input.role, text: input.text, turnId: input.turnId, source: "hook" });
  const contentHash = sha256(content);
  return {
    raw: {
      schemaVersion: 1,
      id: `codex:${input.sessionId}:${input.threadId}:${semanticId}:hook:raw`,
      framework: "codex",
      frameworkSessionId: input.sessionId,
      frameworkThreadId: input.threadId,
      frameworkEntryId: semanticId,
      eventType: "message.created",
      role: input.role,
      timestamp,
      content,
      contentHash,
      sourceRef: refs.sourceRef,
      frameworkSourceRef: refs.frameworkSourceRef,
      metadata: withoutUndefined({
        turnId: input.turnId,
        syntheticHookRecord: true,
        namespaceId: input.hostBinding?.namespaceId,
        hostType: input.hostBinding?.identity.hostType,
        parentThreadId: input.hostBinding?.identity.parentThreadId,
        agentId: input.hostBinding?.identity.agentId,
      }),
      rawFrameworkPayload: content,
    },
    normalized: {
      schemaVersion: 1,
      id: `codex:${input.sessionId}:${input.threadId}:${semanticId}:normalized`,
      sessionId: input.sessionId,
      threadId: input.threadId,
      sourceRef: refs.sourceRef,
      frameworkSourceRef: refs.frameworkSourceRef,
      kind: "message",
      role: input.role,
      text: input.text,
      contentHash,
      createdAt: timestamp,
      metadata: withoutUndefined({
        turnId: input.turnId,
        syntheticHookRecord: true,
        namespaceId: input.hostBinding?.namespaceId,
        hostType: input.hostBinding?.identity.hostType,
        parentThreadId: input.hostBinding?.identity.parentThreadId,
        agentId: input.hostBinding?.identity.agentId,
      }),
    },
  };
}

/** Preserves the exact command-hook delivery as a separate raw audit fact. */
export function normalizeCodexHookEvent(input: CodexHookInput, threadId: string, hostBinding?: HostBinding): TranscriptAppendInput {
  const discriminator = input.turn_id ?? input.tool_use_id ?? input.trigger ?? input.source ?? "session";
  const semanticId = `hook:${input.hook_event_name}:${discriminator}`;
  const refs = codexSourceRefs(input.session_id, threadId, semanticId);
  const content = toJsonValue(input);
  return {
    raw: {
      schemaVersion: 1,
      id: `codex:${input.session_id}:${threadId}:${semanticId}:raw`,
      framework: "codex",
      frameworkSessionId: input.session_id,
      frameworkThreadId: threadId,
      frameworkEntryId: semanticId,
      eventType: hookRawEventType(input.hook_event_name),
      timestamp: new Date().toISOString(),
      content,
      contentHash: sha256(content),
      sourceRef: refs.sourceRef,
      frameworkSourceRef: refs.frameworkSourceRef,
      metadata: withoutUndefined({
        hookEventName: input.hook_event_name,
        turnId: input.turn_id,
        agentId: input.agent_id,
        agentType: input.agent_type,
        // Codex currently exposes no nested parent-agent id. The root session
        // plus spawning turn is therefore the strongest non-invented lineage.
        parentThreadId: input.agent_id ? input.session_id : undefined,
        namespaceId: hostBinding?.namespaceId,
        hostType: hostBinding?.identity.hostType,
      }),
      rawFrameworkPayload: content,
    },
  };
}

function normalizedEntry(input: {
  readonly sessionId: string;
  readonly threadId: string;
  readonly topType: string;
  readonly payload: Record<string, unknown>;
  readonly payloadType?: string;
  readonly semanticId: string;
  readonly timestamp: string;
  readonly turnId?: string;
  readonly refs: { readonly sourceRef: string; readonly frameworkSourceRef: string };
  readonly hostBinding?: HostBinding;
}): NormalizedTranscriptEntry | undefined {
  const base = {
    schemaVersion: 1 as const,
    id: `codex:${input.sessionId}:${input.threadId}:${input.semanticId}:normalized`,
    sessionId: input.sessionId,
    threadId: input.threadId,
    sourceRef: input.refs.sourceRef,
    frameworkSourceRef: input.refs.frameworkSourceRef,
    createdAt: input.timestamp,
    metadata: withoutUndefined({
      turnId: input.turnId,
      codexPayloadType: input.payloadType,
      namespaceId: input.hostBinding?.namespaceId,
      hostType: input.hostBinding?.identity.hostType,
      parentThreadId: input.hostBinding?.identity.parentThreadId,
      agentId: input.hostBinding?.identity.agentId,
    }),
  };

  if (input.topType === "response_item" && input.payloadType === "message") {
    const role = stringValue(input.payload.role);
    if (role !== "user" && role !== "assistant") return undefined;
    const text = messageText(input.payload.content);
    if (!text) return undefined;
    return { ...base, kind: "message", role, text, contentHash: sha256(text) };
  }

  if (input.topType === "response_item" && isToolCallType(input.payloadType)) {
    const toolName = stringValue(input.payload.name) ?? input.payloadType ?? "tool";
    const toolCallId = stringValue(input.payload.call_id) ?? stringValue(input.payload.id) ?? input.semanticId;
    const text = stringifyCompact(input.payload.arguments ?? input.payload.input ?? input.payload.action);
    return { ...base, kind: "tool_call", role: "tool", toolName, toolCallId, text, contentHash: sha256(text) };
  }

  if (input.topType === "response_item" && isToolResultType(input.payloadType)) {
    const toolCallId = stringValue(input.payload.call_id) ?? stringValue(input.payload.id) ?? input.semanticId;
    const text = stringifyCompact(input.payload.output ?? input.payload.content ?? input.payload.result);
    return {
      ...base,
      kind: "tool_result",
      role: "tool",
      toolCallId,
      text,
      ...(input.payload.is_error === true ? { isError: true } : {}),
      contentHash: sha256(text),
    };
  }

  if (input.topType === "compacted") {
    const text = compactionText(input.payload);
    return { ...base, kind: "compaction", role: "summary", text, contentHash: sha256(text) };
  }

  if (input.topType === "event_msg" && ["task_complete", "turn_aborted"].includes(input.payloadType ?? "")) {
    const text = input.payloadType === "turn_aborted" ? "Codex turn aborted." : "Codex turn completed.";
    return { ...base, kind: "lifecycle", role: "system", text, contentHash: sha256(text) };
  }
  return undefined;
}

function semanticEntryId(
  payload: Record<string, unknown>,
  topType: string,
  lineNumber: number,
  turnId: string | undefined,
): string {
  if (topType === "response_item" && payload.type === "message") {
    const role = stringValue(payload.role) ?? "message";
    return messageSemanticId(turnId ?? "unknown-turn", role, messageText(payload.content) ?? stringifyCompact(payload.content));
  }
  const payloadType = stringValue(payload.type);
  const callId = stringValue(payload.call_id);
  if (callId && isToolCallType(payloadType)) return `tool-call:${callId}`;
  if (callId && isToolResultType(payloadType)) return `tool-result:${callId}`;
  return stringValue(payload.call_id) ?? stringValue(payload.id) ?? stringValue(payload.window_id) ?? `${topType}-${lineNumber}`;
}

function messageSemanticId(turnId: string, role: string, text: string): string {
  return `${turnId}:${role}:${sha256(text).slice(0, 16)}`;
}

function rawEventType(topType: string, payloadType: string | undefined): RawTranscriptRecord["eventType"] {
  if (topType === "session_meta") return "session.started";
  if (topType === "compacted") return "compact.completed";
  if (topType === "event_msg" && payloadType === "task_complete") return "turn.completed";
  if (topType === "response_item" && isToolCallType(payloadType)) return "tool.called";
  if (topType === "response_item" && isToolResultType(payloadType)) return "tool.completed";
  if (topType === "response_item" && payloadType === "message") return "message.created";
  return "message.updated";
}

function hookRawEventType(event: CodexHookInput["hook_event_name"]): RawTranscriptRecord["eventType"] {
  switch (event) {
    case "SessionStart": return "session.started";
    case "UserPromptSubmit": return "message.created";
    case "PreToolUse": return "tool.called";
    case "PermissionRequest": return "tool.called";
    case "PostToolUse": return "tool.completed";
    case "PreCompact": return "message.updated";
    case "PostCompact": return "compact.completed";
    case "Stop":
    case "SubagentStop": return "turn.completed";
    case "SubagentStart": return "session.started";
  }
}

function rawRole(payload: Record<string, unknown>): RawTranscriptRecord["role"] | undefined {
  const role = stringValue(payload.role);
  if (role === "system" || role === "user" || role === "assistant") return role;
  if (isToolCallType(stringValue(payload.type)) || isToolResultType(stringValue(payload.type))) return "tool";
  return undefined;
}

function compactionText(payload: Record<string, unknown>): string {
  const message = isRecord(payload.message) ? payload.message : {};
  const summary = messageText(message.content);
  if (summary) return summary;
  return `Codex compacted context window ${stringValue(payload.window_id) ?? stringValue(payload.window_number) ?? "unknown"}.`;
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((item) => {
    if (!isRecord(item)) return [];
    if ((item.type === "input_text" || item.type === "output_text" || item.type === "text") && typeof item.text === "string") return [item.text];
    return [];
  }).join("\n").trim();
  return text || undefined;
}

function isToolCallType(type: string | undefined): boolean {
  return type === "function_call" || type === "custom_tool_call" || type === "local_shell_call" || type === "web_search_call";
}

function isToolResultType(type: string | undefined): boolean {
  return type === "function_call_output" || type === "custom_tool_call_output" || type === "local_shell_call_output" || type === "web_search_call_output";
}

function codexSourceRefs(sessionId: string, threadId: string, entryId: string) {
  const encoded = [sessionId, threadId, entryId].map(encodeURIComponent);
  return {
    sourceRef: `agentengram://transcript/codex/${encoded.join("/")}`,
    frameworkSourceRef: `codex://rollout/${encoded.join("/")}`,
  };
}

function stringifyCompact(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? null); } catch { return String(value); }
}

function timestampToIso(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return new Date(0).toISOString();
}

function withoutUndefined(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, toJsonValue(item)]));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseByteOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Codex rollout checkpoint has an invalid byte offset");
  return parsed;
}

function decodePartialTail(value: string | undefined): Buffer {
  if (!value) return Buffer.alloc(0);
  return Buffer.from(value, "base64");
}

function parserText(checkpoint: SourceCheckpoint | undefined, key: string): string | undefined {
  const value = checkpoint?.parserState?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parserInteger(checkpoint: SourceCheckpoint | undefined, key: string): number {
  const value = checkpoint?.parserState?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
