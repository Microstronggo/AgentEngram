import type { JsonValue } from "../storage/index.js";
import type { NormalizedTranscriptEntry } from "./normalized-transcript-entry.js";
import type { RawTranscriptRecord } from "./raw-transcript-record.js";

/** Validates and encodes one raw fact as a canonical JSONL line. */
export function encodeRawTranscriptRecord(record: RawTranscriptRecord): string {
  validateRawTranscriptRecord(record);
  return `${JSON.stringify(record)}\n`;
}

/** Parses and validates one raw transcript JSONL line. */
export function decodeRawTranscriptRecord(line: string): RawTranscriptRecord {
  const value = JSON.parse(line) as unknown;
  validateRawTranscriptRecord(value);
  return value;
}

/** Validates and encodes one portable transcript entry as canonical JSONL. */
export function encodeNormalizedTranscriptEntry(entry: NormalizedTranscriptEntry): string {
  validateNormalizedTranscriptEntry(entry);
  return `${JSON.stringify(entry)}\n`;
}

/** Parses and validates one normalized transcript JSONL line. */
export function decodeNormalizedTranscriptEntry(line: string): NormalizedTranscriptEntry {
  const value = JSON.parse(line) as unknown;
  validateNormalizedTranscriptEntry(value);
  return value;
}

/** Runtime schema guard for durable raw transcript facts. */
export function validateRawTranscriptRecord(value: unknown): asserts value is RawTranscriptRecord {
  if (!isRecord(value)) throw new Error("raw transcript record must be an object");
  if (value.schemaVersion !== 1) throw new Error("raw transcript schemaVersion must be 1");
  requireString(value.id, "id");
  requireString(value.framework, "framework");
  requireString(value.frameworkSessionId, "frameworkSessionId");
  requireString(value.eventType, "eventType");
  requireString(value.timestamp, "timestamp");
  requireString(value.contentHash, "contentHash");
  requireString(value.sourceRef, "sourceRef");
  optionalString(value.frameworkThreadId, "frameworkThreadId");
  optionalString(value.frameworkEntryId, "frameworkEntryId");
  optionalStringOrNull(value.parentEntryId, "parentEntryId");
  optionalString(value.role, "role");
  optionalString(value.frameworkSourceRef, "frameworkSourceRef");
  optionalJson(value.content, "content");
  optionalJsonRecord(value.metadata, "metadata");
  optionalJson(value.rawFrameworkPayload, "rawFrameworkPayload");
  validateBlobRef(value.blobRef);
}

/** Runtime schema guard for portable normalized transcript entries. */
export function validateNormalizedTranscriptEntry(value: unknown): asserts value is NormalizedTranscriptEntry {
  if (!isRecord(value)) throw new Error("normalized transcript entry must be an object");
  if (value.schemaVersion !== 1) throw new Error("normalized transcript schemaVersion must be 1");
  requireString(value.id, "id");
  requireString(value.sessionId, "sessionId");
  requireString(value.threadId, "threadId");
  requireString(value.sourceRef, "sourceRef");
  requireString(value.kind, "kind");
  requireString(value.contentHash, "contentHash");
  requireString(value.createdAt, "createdAt");
  optionalString(value.frameworkSourceRef, "frameworkSourceRef");
  optionalString(value.role, "role");
  optionalString(value.text, "text");
  optionalString(value.toolName, "toolName");
  optionalString(value.toolCallId, "toolCallId");
  optionalStringOrNull(value.parentEntryId, "parentEntryId");
  if (value.isError !== undefined && typeof value.isError !== "boolean") throw new Error("isError must be boolean");
  optionalJsonRecord(value.metadata, "metadata");
  validateBlobRef(value.blobRef);
}

/** Converts arbitrary provider payloads into a serializable, cycle-safe JSON view. */
export function toJsonValue(value: unknown): JsonValue {
  const converted = JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  return converted;
}

function validateBlobRef(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("blobRef must be an object");
  if (value.algorithm !== "sha256") throw new Error("blobRef.algorithm must be sha256");
  requireString(value.digest, "blobRef.digest");
  if (typeof value.byteLength !== "number" || !Number.isFinite(value.byteLength)) {
    throw new Error("blobRef.byteLength must be finite number");
  }
  requireString(value.mediaType, "blobRef.mediaType");
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be non-empty string`);
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error(`${field} must be string`);
}

function optionalStringOrNull(value: unknown, field: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") throw new Error(`${field} must be string or null`);
}

function optionalJson(value: unknown, field: string): void {
  if (value !== undefined && !isJsonValue(value)) throw new Error(`${field} must be JSON value`);
}

function optionalJsonRecord(value: unknown, field: string): void {
  if (value !== undefined && (!isRecord(value) || !isJsonValue(value))) throw new Error(`${field} must be JSON object`);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
