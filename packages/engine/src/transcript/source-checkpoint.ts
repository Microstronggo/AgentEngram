import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "../storage/serialization.js";

/** Cursor representation understood by one adapter-owned transcript source. */
export type SourceCursorType = "byte-offset" | "event-id" | "entry-id" | "sequence";

/**
 * Durable ingestion waterline for an external transcript source.
 *
 * This checkpoint advances only after Portable Transcript persistence. It is
 * deliberately independent from Cell Formation's transcript cursor, because
 * model extraction failures must never cause raw host evidence to be reread.
 */
export interface SourceCheckpoint {
  readonly schemaVersion: 1;
  /** Stable adapter-defined source identity, such as one Codex rollout file. */
  readonly sourceId: string;
  /** Optional file identity or upstream revision used to detect replacement. */
  readonly sourceVersion?: string;
  readonly cursorType: SourceCursorType;
  /** String form preserves offsets and upstream sequence values without precision loss. */
  readonly cursorValue: string;
  /** Encoded incomplete source bytes retained until the next incremental read. */
  readonly partialTail?: string;
  /** Adapter parser continuity, for example the current turn and line number. */
  readonly parserState?: Readonly<Record<string, JsonValue>>;
  readonly updatedAt: string;
}

/** Persistence boundary used by incremental transcript adapters. */
export interface SourceCheckpointRepository {
  load(sourceId: string): Promise<SourceCheckpoint | undefined>;
  save(checkpoint: SourceCheckpoint): Promise<void>;
  remove(sourceId: string): Promise<void>;
}

/** Atomic filesystem repository with one independently replaceable source file. */
export class FileSourceCheckpointRepository implements SourceCheckpointRepository {
  /** Serializes updates per source so an older async writer cannot overwrite a newer cursor. */
  private readonly pending = new Map<string, Promise<unknown>>();

  public constructor(private readonly rootDir: string) {
    if (!rootDir.trim()) throw new Error("source checkpoint rootDir is required");
  }

  /** Loads and validates a source checkpoint; malformed state fails visibly. */
  public async load(sourceId: string): Promise<SourceCheckpoint | undefined> {
    validateRequiredText(sourceId, "sourceId");
    let content: string;
    try {
      content = await readFile(this.pathFor(sourceId), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    const checkpoint = decodeSourceCheckpoint(content);
    // Hash-based filenames avoid path traversal. This check also protects
    // against a misplaced file or an astronomically unlikely hash collision.
    if (checkpoint.sourceId !== sourceId) throw new Error("source checkpoint identity does not match requested sourceId");
    return checkpoint;
  }

  /** Fsyncs a complete temporary file before atomically publishing it. */
  public save(checkpoint: SourceCheckpoint): Promise<void> {
    validateSourceCheckpoint(checkpoint);
    const previous = this.pending.get(checkpoint.sourceId) ?? Promise.resolve();
    const operation = previous.then(() => this.saveAtomic(checkpoint));
    this.pending.set(checkpoint.sourceId, operation.catch(() => undefined));
    return operation;
  }

  private async saveAtomic(checkpoint: SourceCheckpoint): Promise<void> {
    const current = await this.load(checkpoint.sourceId);
    if (current) assertCheckpointDoesNotRegress(current, checkpoint);
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const target = this.pathFor(checkpoint.sourceId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${encodeSourceCheckpoint(checkpoint)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      const directory = await open(this.rootDir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /** Removes only the requested source waterline; transcript truth is untouched. */
  public async remove(sourceId: string): Promise<void> {
    validateRequiredText(sourceId, "sourceId");
    await unlink(this.pathFor(sourceId)).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }

  private pathFor(sourceId: string): string {
    const digest = createHash("sha256").update(sourceId).digest("hex");
    return join(this.rootDir, `${digest}.json`);
  }
}

/** Rejects comparable cursor rollback while permitting an explicit source replacement. */
function assertCheckpointDoesNotRegress(current: SourceCheckpoint, next: SourceCheckpoint): void {
  if (current.cursorType !== next.cursorType) throw new Error("source checkpoint cursorType cannot change");
  if (current.sourceVersion !== next.sourceVersion) return;
  if (next.parserState?.sourceReset === true) return;
  if (next.cursorType !== "byte-offset" && next.cursorType !== "sequence") return;
  const currentValue = parseComparableCursor(current.cursorValue);
  const nextValue = parseComparableCursor(next.cursorValue);
  if (nextValue < currentValue) throw new Error("source checkpoint cursor cannot regress");
}

function parseComparableCursor(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error("comparable source checkpoint cursor must be a non-negative integer");
  return BigInt(value);
}

/** Encodes a validated checkpoint to its portable JSON representation. */
export function encodeSourceCheckpoint(checkpoint: SourceCheckpoint): string {
  validateSourceCheckpoint(checkpoint);
  return JSON.stringify(checkpoint);
}

/** Decodes untrusted on-disk JSON and validates every durable field. */
export function decodeSourceCheckpoint(value: string): SourceCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`source checkpoint is not valid JSON: ${errorMessage(error)}`);
  }
  validateSourceCheckpoint(parsed);
  return parsed;
}

/** Runtime validator shared by codec and repository boundaries. */
export function validateSourceCheckpoint(value: unknown): asserts value is SourceCheckpoint {
  if (!isRecord(value)) throw new Error("source checkpoint must be an object");
  if (value.schemaVersion !== 1) throw new Error("unsupported source checkpoint schema version");
  validateRequiredText(value.sourceId, "sourceId");
  validateOptionalText(value.sourceVersion, "sourceVersion");
  if (!isCursorType(value.cursorType)) throw new Error("source checkpoint cursorType is invalid");
  validateRequiredText(value.cursorValue, "cursorValue");
  validateOptionalText(value.partialTail, "partialTail", true);
  if (value.parserState !== undefined && !isJsonObject(value.parserState)) {
    throw new Error("source checkpoint parserState must contain only JSON values");
  }
  validateRequiredText(value.updatedAt, "updatedAt");
  if (!Number.isFinite(Date.parse(value.updatedAt as string))) throw new Error("source checkpoint updatedAt is invalid");
}

function isCursorType(value: unknown): value is SourceCursorType {
  return value === "byte-offset" || value === "event-id" || value === "entry-id" || value === "sequence";
}

function validateRequiredText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`source checkpoint ${name} is required`);
}

function validateOptionalText(value: unknown, name: string, allowEmpty = false): void {
  if (value === undefined) return;
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`source checkpoint ${name} is invalid`);
  }
}

function isJsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
