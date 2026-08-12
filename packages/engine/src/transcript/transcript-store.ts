import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { BlobStore, type BlobReference } from "../storage/blob-store.js";
import { acquireFileLock } from "../storage/file-lock.js";
import { type JsonValue, sha256 } from "../storage/serialization.js";
import {
  decodeNormalizedTranscriptEntry,
  decodeRawTranscriptRecord,
  encodeNormalizedTranscriptEntry,
  encodeRawTranscriptRecord,
  toJsonValue,
} from "./transcript-codec.js";
import type { NormalizedTranscriptEntry } from "./normalized-transcript-entry.js";
import type { RawTranscriptRecord } from "./raw-transcript-record.js";

type TranscriptStream = "raw" | "normalized";

/** Filesystem, indexing, and large-content policy for portable transcript storage. */
export interface TranscriptStoreOptions {
  /** Root project directory that owns portable transcript files and their rebuildable index. */
  readonly rootDir: string;
  /** Byte threshold after which large raw content is offloaded to BlobStore. */
  readonly largeContentBytes?: number;
  /** Injectable blob store for tests or host-managed storage backends. */
  readonly blobStore?: BlobStore;
  /** Maximum wait for another process appending to the same host session. */
  readonly lockTimeoutMs?: number;
}

/** Raw fact plus its optional portable projection, committed as one logical append. */
export interface TranscriptAppendInput {
  readonly raw: RawTranscriptRecord;
  readonly normalized?: NormalizedTranscriptEntry;
}

/** Cursor request used by per-thread Cell Formation scans. */
export interface TranscriptReadAfterInput {
  readonly sessionId: string;
  readonly threadId: string;
  readonly cursor?: string;
}

/** Integrity summary used by doctor and migration commands without exposing transcript content. */
export interface TranscriptVerification {
  readonly sessionId: string;
  readonly rawRecords: number;
  readonly normalizedRecords: number;
  readonly rawValidBytes: number;
  readonly normalizedValidBytes: number;
  readonly rawFileBytes: number;
  readonly normalizedFileBytes: number;
  readonly valid: boolean;
  /** True only when an explicit repair changed durable transcript truth. */
  readonly repaired: boolean;
  /** Paths containing byte-for-byte copies of malformed suffixes removed during repair. */
  readonly quarantinePaths?: readonly string[];
}

/** Raised when durable formation state references an entry absent from transcript truth. */
export class TranscriptCursorNotFoundError extends Error {
  public constructor(readonly cursor: string) {
    super(`transcript cursor was not found: ${cursor}`);
    this.name = "TranscriptCursorNotFoundError";
  }
}

/**
 * Append-only JSONL truth store with a rebuildable SQLite id/offset projection.
 * JSONL remains authoritative: the index is reconciled from valid file prefixes
 * after crashes, and a per-session file lock serializes writers across processes.
 */
export class TranscriptStore {
  /** Large-content threshold used for both raw and normalized transcript payloads. */
  private readonly largeContentBytes: number;
  /** Content-addressed storage for payloads too large for readable JSONL rows. */
  private readonly blobStore: BlobStore;
  /** Rebuildable projection used only for idempotency and cursor offsets. */
  private readonly database: Database.Database;
  /** Prevents new operations after the projection handle is released. */
  private closed = false;

  /** @param options Storage root, append lock, and content-offload policy. */
  constructor(private readonly options: TranscriptStoreOptions) {
    this.largeContentBytes = options.largeContentBytes ?? 64 * 1024;
    this.blobStore = options.blobStore ?? new BlobStore(join(options.rootDir, "blobs"));
    const databasePath = join(options.rootDir, "transcripts", "index.db");
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 10000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS transcript_records (
        session_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_id TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        PRIMARY KEY(session_id, stream, record_id)
      );
      CREATE TABLE IF NOT EXISTS transcript_streams (
        session_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        indexed_size INTEGER NOT NULL,
        PRIMARY KEY(session_id, stream)
      );
      CREATE INDEX IF NOT EXISTS transcript_records_order
        ON transcript_records(session_id, stream, byte_offset);
    `);
  }

  /** Idempotently appends one raw/normalized transcript pair. */
  async append(input: TranscriptAppendInput): Promise<void> {
    await this.appendMany([input]);
  }

  /** Appends one or more host batches without reading or rewriting valid prefixes. */
  async appendMany(inputs: readonly TranscriptAppendInput[]): Promise<void> {
    this.assertOpen();
    const groups = new Map<string, TranscriptAppendInput[]>();
    for (const input of inputs) {
      const sessionId = input.raw.frameworkSessionId;
      if (input.normalized && input.normalized.sessionId !== sessionId) {
        throw new Error("normalized transcript sessionId must match raw frameworkSessionId");
      }
      const group = groups.get(sessionId) ?? [];
      group.push(input);
      groups.set(sessionId, group);
    }

    for (const [sessionId, group] of groups) {
      // Blob preparation happens before the short append lock; content-addressed
      // writes are idempotent and should not extend the host critical section.
      const prepared = await Promise.all(group.map(async (input) => ({
        raw: await this.prepareRaw(input.raw),
        ...(input.normalized ? { normalized: await this.prepareNormalized(input.normalized) } : {}),
      })));
      await this.withSessionLock(sessionId, async () => {
        await this.reconcileStream(sessionId, "raw");
        await this.reconcileStream(sessionId, "normalized");
        const rawRows = uniqueNewRows(prepared.map(({ raw }) => ({ id: raw.id, line: encodeRawTranscriptRecord(raw) })),
          (id) => this.hasIndexedRecord(sessionId, "raw", id));
        const normalizedRows = uniqueNewRows(prepared.flatMap(({ normalized }) => normalized
          ? [{ id: normalized.id, line: encodeNormalizedTranscriptEntry(normalized) }]
          : []), (id) => this.hasIndexedRecord(sessionId, "normalized", id));
        await this.appendRows(sessionId, "raw", rawRows);
        // A crash between streams is repaired by host replay: raw dedupes while
        // the missing normalized row is appended before SourceCheckpoint moves.
        await this.appendRows(sessionId, "normalized", normalizedRows);
      });
    }
  }

  /** Appends an audit-only framework fact without a normalized projection. */
  async appendRaw(record: RawTranscriptRecord): Promise<void> {
    await this.append({ raw: record });
  }

  /** Appends a derived normalized entry when raw truth was persisted separately. */
  async appendNormalized(sessionId: string, entry: NormalizedTranscriptEntry): Promise<void> {
    this.assertOpen();
    if (entry.sessionId !== sessionId) throw new Error("normalized transcript sessionId does not match destination");
    const normalized = await this.prepareNormalized(entry);
    await this.withSessionLock(sessionId, async () => {
      await this.reconcileStream(sessionId, "normalized");
      if (this.hasIndexedRecord(sessionId, "normalized", normalized.id)) return;
      await this.appendRows(sessionId, "normalized", [{ id: normalized.id, line: encodeNormalizedTranscriptEntry(normalized) }]);
    });
  }

  /** Reads the valid raw JSONL prefix for one host session. */
  async readRaw(sessionId: string): Promise<readonly RawTranscriptRecord[]> {
    this.assertOpen();
    return readJsonlPrefix(this.streamPath(sessionId, "raw"), decodeRawTranscriptRecord);
  }

  /** Reads the valid normalized JSONL prefix for one host session. */
  async readNormalized(sessionId: string): Promise<readonly NormalizedTranscriptEntry[]> {
    this.assertOpen();
    return readJsonlPrefix(this.streamPath(sessionId, "normalized"), decodeNormalizedTranscriptEntry);
  }

  /** Reads one thread after an indexed cursor without rescanning the old prefix. */
  async readNormalizedAfter(input: TranscriptReadAfterInput): Promise<readonly NormalizedTranscriptEntry[]> {
    this.assertOpen();
    let startOffset = 0;
    await this.withSessionLock(input.sessionId, async () => {
      await this.reconcileStream(input.sessionId, "normalized");
      if (input.cursor === undefined) return;
      const row = this.database.prepare(`SELECT byte_offset, byte_length FROM transcript_records
        WHERE session_id = ? AND stream = 'normalized' AND record_id = ?`)
        .get(input.sessionId, input.cursor) as { byte_offset: number; byte_length: number } | undefined;
      if (!row) throw new TranscriptCursorNotFoundError(input.cursor);
      startOffset = row.byte_offset + row.byte_length;
    });
    return (await readJsonlPrefix(this.streamPath(input.sessionId, "normalized"), decodeNormalizedTranscriptEntry, startOffset))
      .filter((entry) => entry.threadId === input.threadId);
  }

  /** Lists durable session ids known to the rebuildable projection. */
  listSessions(): readonly string[] {
    this.assertOpen();
    const rows = this.database.prepare("SELECT DISTINCT session_id FROM transcript_streams ORDER BY session_id")
      .all() as Array<{ session_id: string }>;
    return rows.map(({ session_id }) => session_id);
  }

  /** Discovers pre-index JSONL sessions so legacy roots can be verified in one command. */
  async discoverSessions(): Promise<readonly string[]> {
    this.assertOpen();
    const sessions = new Set(this.listSessions());
    const root = join(this.options.rootDir, "transcripts");
    const directories = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const raw = await readJsonlPrefix(join(root, directory.name, "raw.jsonl"), decodeRawTranscriptRecord);
      const normalized = await readJsonlPrefix(join(root, directory.name, "normalized.jsonl"), decodeNormalizedTranscriptEntry);
      const sessionId = raw[0]?.frameworkSessionId ?? normalized[0]?.sessionId;
      if (sessionId) sessions.add(sessionId);
    }
    return [...sessions].sort();
  }

  /** Inspects both JSONL streams without modifying truth or the rebuildable index. */
  async verify(sessionId: string): Promise<TranscriptVerification> {
    this.assertOpen();
    return this.withSessionLock(sessionId, async () => {
      const raw = await inspectJsonl(this.streamPath(sessionId, "raw"), decodeRawTranscriptRecord);
      const normalized = await inspectJsonl(this.streamPath(sessionId, "normalized"), decodeNormalizedTranscriptEntry);
      return {
        sessionId,
        rawRecords: raw.records.length,
        normalizedRecords: normalized.records.length,
        rawValidBytes: raw.validBytes,
        normalizedValidBytes: normalized.validBytes,
        rawFileBytes: raw.fileBytes,
        normalizedFileBytes: normalized.fileBytes,
        valid: streamIsValid(raw) && streamIsValid(normalized),
        repaired: false,
      };
    });
  }

  /**
   * Repairs malformed suffixes explicitly, preserving every removed byte under
   * the session quarantine directory before rebuilding the offset projection.
   */
  async repair(sessionId: string): Promise<TranscriptVerification> {
    this.assertOpen();
    return this.withSessionLock(sessionId, async () => {
      const quarantinePaths: string[] = [];
      const rawBefore = await inspectJsonl(this.streamPath(sessionId, "raw"), decodeRawTranscriptRecord);
      const normalizedBefore = await inspectJsonl(this.streamPath(sessionId, "normalized"), decodeNormalizedTranscriptEntry);
      await this.repairStream(sessionId, "raw", rawBefore, quarantinePaths);
      await this.repairStream(sessionId, "normalized", normalizedBefore, quarantinePaths);
      await this.reconcileStream(sessionId, "raw", true);
      await this.reconcileStream(sessionId, "normalized", true);
      const raw = await inspectJsonl(this.streamPath(sessionId, "raw"), decodeRawTranscriptRecord);
      const normalized = await inspectJsonl(this.streamPath(sessionId, "normalized"), decodeNormalizedTranscriptEntry);
      const repaired = !streamIsValid(rawBefore) || !streamIsValid(normalizedBefore);
      return {
        sessionId,
        rawRecords: raw.records.length,
        normalizedRecords: normalized.records.length,
        rawValidBytes: raw.validBytes,
        normalizedValidBytes: normalized.validBytes,
        rawFileBytes: raw.fileBytes,
        normalizedFileBytes: normalized.fileBytes,
        valid: streamIsValid(raw) && streamIsValid(normalized),
        repaired,
        ...(quarantinePaths.length === 0 ? {} : { quarantinePaths }),
      };
    });
  }

  /**
   * Removes one session's transcript truth and index rows, then garbage
   * collects project blobs that no remaining transcript entry references.
   */
  async purgeSession(sessionId: string): Promise<{ readonly removedBlobs: number }> {
    this.assertOpen();
    const directory = dirname(this.streamPath(sessionId, "raw"));
    await this.withSessionLock(sessionId, async () => {
      await rm(this.streamPath(sessionId, "raw"), { force: true });
      await rm(this.streamPath(sessionId, "normalized"), { force: true });
      await rm(join(directory, "quarantine"), { recursive: true, force: true });
      this.database.transaction(() => {
        this.database.prepare("DELETE FROM transcript_records WHERE session_id = ?").run(sessionId);
        this.database.prepare("DELETE FROM transcript_streams WHERE session_id = ?").run(sessionId);
      })();
    });
    // Remove the now-empty directory only if no writer recreated content after
    // lock release. ENOTEMPTY deliberately preserves a concurrent new append.
    await rmdir(directory).catch((error: unknown) => {
      if (!isDirectoryNotEmptyOrMissing(error)) throw error;
    });
    return { removedBlobs: await this.blobStore.prune(await this.referencedBlobDigests()) };
  }

  /** Releases only the rebuildable index; JSONL and blobs remain durable. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private async appendRows(sessionId: string, stream: TranscriptStream, rows: readonly EncodedRow[]): Promise<void> {
    if (rows.length === 0) return;
    const path = this.streamPath(sessionId, stream);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const before = await fileSize(path);
    const file = await open(path, "a", 0o600);
    try {
      await file.writeFile(rows.map(({ line }) => line).join(""), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    const insert = this.database.prepare(`INSERT OR IGNORE INTO transcript_records
      (session_id, stream, record_id, byte_offset, byte_length) VALUES (?, ?, ?, ?, ?)`);
    let offset = before;
    const commit = this.database.transaction(() => {
      for (const row of rows) {
        const length = Buffer.byteLength(row.line, "utf8");
        insert.run(sessionId, stream, row.id, offset, length);
        offset += length;
      }
      this.saveIndexedSize(sessionId, stream, offset);
    });
    commit();
  }

  /** Rebuilds the projection whenever truth size differs, preserving malformed suffixes first. */
  private async reconcileStream(sessionId: string, stream: TranscriptStream, force = false): Promise<void> {
    const path = this.streamPath(sessionId, stream);
    const size = await fileSize(path);
    const metadata = this.database.prepare("SELECT indexed_size FROM transcript_streams WHERE session_id = ? AND stream = ?")
      .get(sessionId, stream) as { indexed_size: number } | undefined;
    if (!force && metadata?.indexed_size === size) return;

    const inspection = stream === "raw"
      ? await inspectJsonl(path, decodeRawTranscriptRecord)
      : await inspectJsonl(path, decodeNormalizedTranscriptEntry);
    await this.repairStream(sessionId, stream, inspection, []);
    const indexedSize = inspection.validBytes + (inspection.needsTrailingNewline ? 1 : 0);
    const replace = this.database.transaction(() => {
      this.database.prepare("DELETE FROM transcript_records WHERE session_id = ? AND stream = ?").run(sessionId, stream);
      const insert = this.database.prepare(`INSERT INTO transcript_records
        (session_id, stream, record_id, byte_offset, byte_length) VALUES (?, ?, ?, ?, ?)`);
      for (const [index, row] of inspection.records.entries()) {
        const extraNewline = inspection.needsTrailingNewline && index === inspection.records.length - 1 ? 1 : 0;
        insert.run(sessionId, stream, row.id, row.byteOffset, row.byteLength + extraNewline);
      }
      this.saveIndexedSize(sessionId, stream, indexedSize);
    });
    replace();
  }

  /** Copies corrupt bytes out of the fact stream before truncation and newline repair. */
  private async repairStream(
    sessionId: string,
    stream: TranscriptStream,
    inspection: JsonlInspection<unknown>,
    quarantinePaths: string[],
  ): Promise<void> {
    const path = this.streamPath(sessionId, stream);
    if (inspection.validBytes < inspection.fileBytes) {
      const content = await readFile(path);
      const suffix = content.subarray(inspection.validBytes);
      const quarantineDir = join(dirname(path), "quarantine");
      await mkdir(quarantineDir, { recursive: true, mode: 0o700 });
      const quarantinePath = join(quarantineDir, `${stream}-${Date.now()}-${createHash("sha256").update(suffix).digest("hex").slice(0, 12)}.bin`);
      const temporary = `${quarantinePath}.${process.pid}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(suffix);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, quarantinePath);
      quarantinePaths.push(quarantinePath);
      await truncate(path, inspection.validBytes);
    }
    if (inspection.needsTrailingNewline) {
      const file = await open(path, "a", 0o600);
      try {
        await file.writeFile("\n", "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
    }
  }

  private saveIndexedSize(sessionId: string, stream: TranscriptStream, size: number): void {
    this.database.prepare(`INSERT INTO transcript_streams(session_id, stream, indexed_size) VALUES (?, ?, ?)
      ON CONFLICT(session_id, stream) DO UPDATE SET indexed_size = excluded.indexed_size`)
      .run(sessionId, stream, size);
  }

  private hasIndexedRecord(sessionId: string, stream: TranscriptStream, id: string): boolean {
    return this.database.prepare("SELECT 1 FROM transcript_records WHERE session_id = ? AND stream = ? AND record_id = ?")
      .get(sessionId, stream, id) !== undefined;
  }

  private withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = join(this.options.rootDir, "transcripts", stablePathSegment(sessionId), ".append.lock");
    const lockOptions = this.options.lockTimeoutMs === undefined ? {} : { timeoutMs: this.options.lockTimeoutMs };
    return acquireFileLock(lockPath, lockOptions).then(async (lease) => {
      try { return await operation(); } finally { await lease.release(); }
    });
  }

  private async prepareRaw(record: RawTranscriptRecord): Promise<RawTranscriptRecord> {
    const offloaded = await offloadContent(record.content, this.blobStore, this.largeContentBytes);
    if (!offloaded.blobRef) return record;
    return {
      ...record,
      contentHash: record.contentHash || offloaded.contentHash,
      blobRef: offloaded.blobRef,
      ...(offloaded.preview === undefined ? {} : { content: offloaded.preview }),
    };
  }

  private async prepareNormalized(entry: NormalizedTranscriptEntry): Promise<NormalizedTranscriptEntry> {
    const textBytes = Buffer.byteLength(entry.text ?? "", "utf8");
    if (!entry.text || textBytes <= this.largeContentBytes) return entry;
    const blobRef = await this.blobStore.put(entry.text);
    return { ...entry, text: preview(entry.text), contentHash: entry.contentHash || sha256(entry.text), blobRef };
  }

  private streamPath(sessionId: string, stream: TranscriptStream): string {
    return join(this.options.rootDir, "transcripts", stablePathSegment(sessionId), `${stream}.jsonl`);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("TranscriptStore is closed");
  }

  private async referencedBlobDigests(): Promise<ReadonlySet<string>> {
    const digests = new Set<string>();
    for (const sessionId of await this.discoverSessions()) {
      for (const record of await this.readRaw(sessionId)) if (record.blobRef) digests.add(record.blobRef.digest);
      for (const entry of await this.readNormalized(sessionId)) if (entry.blobRef) digests.add(entry.blobRef.digest);
    }
    return digests;
  }
}

interface EncodedRow { readonly id: string; readonly line: string }
interface InspectedRow<T> { readonly id: string; readonly value: T; readonly byteOffset: number; readonly byteLength: number }
interface JsonlInspection<T> {
  readonly records: readonly InspectedRow<T>[];
  readonly validBytes: number;
  readonly fileBytes: number;
  readonly needsTrailingNewline: boolean;
}

function streamIsValid(inspection: JsonlInspection<unknown>): boolean {
  return inspection.validBytes === inspection.fileBytes && !inspection.needsTrailingNewline;
}

function uniqueNewRows(rows: readonly EncodedRow[], exists: (id: string) => boolean): EncodedRow[] {
  const seen = new Set<string>();
  return rows.filter(({ id }) => !seen.has(id) && !exists(id) && Boolean(seen.add(id)));
}

async function inspectJsonl<T>(path: string, decode: (line: string) => T): Promise<JsonlInspection<T>> {
  const buffer = await readFile(path).catch((error: unknown) => {
    if (isMissing(error)) return Buffer.alloc(0);
    throw error;
  });
  const records: InspectedRow<T>[] = [];
  let lineStart = 0;
  while (lineStart < buffer.length) {
    const newline = buffer.indexOf(0x0a, lineStart);
    const lineEnd = newline < 0 ? buffer.length : newline;
    const line = buffer.subarray(lineStart, lineEnd).toString("utf8");
    if (line.trim()) {
      try {
        const value = decode(line);
        const id = recordId(value);
        records.push({ id, value, byteOffset: lineStart, byteLength: lineEnd - lineStart + (newline < 0 ? 0 : 1) });
      } catch {
        return { records, validBytes: lineStart, fileBytes: buffer.length, needsTrailingNewline: false };
      }
    }
    if (newline < 0) return { records, validBytes: buffer.length, fileBytes: buffer.length, needsTrailingNewline: true };
    lineStart = newline + 1;
  }
  return { records, validBytes: buffer.length, fileBytes: buffer.length, needsTrailingNewline: false };
}

async function readJsonlPrefix<T>(path: string, decode: (line: string) => T, startOffset = 0): Promise<readonly T[]> {
  const buffer = await readFile(path).catch((error: unknown) => {
    if (isMissing(error)) return Buffer.alloc(0);
    throw error;
  });
  if (startOffset > buffer.length) return [];
  const inspection = inspectJsonlBuffer(buffer.subarray(startOffset), decode);
  return inspection.records.map(({ value }) => value);
}

function inspectJsonlBuffer<T>(buffer: Buffer, decode: (line: string) => T): JsonlInspection<T> {
  const records: InspectedRow<T>[] = [];
  let lineStart = 0;
  while (lineStart < buffer.length) {
    const newline = buffer.indexOf(0x0a, lineStart);
    const lineEnd = newline < 0 ? buffer.length : newline;
    const line = buffer.subarray(lineStart, lineEnd).toString("utf8");
    if (line.trim()) {
      try {
        const value = decode(line);
        records.push({ id: recordId(value), value, byteOffset: lineStart, byteLength: lineEnd - lineStart + (newline < 0 ? 0 : 1) });
      } catch {
        return { records, validBytes: lineStart, fileBytes: buffer.length, needsTrailingNewline: false };
      }
    }
    if (newline < 0) return { records, validBytes: buffer.length, fileBytes: buffer.length, needsTrailingNewline: true };
    lineStart = newline + 1;
  }
  return { records, validBytes: buffer.length, fileBytes: buffer.length, needsTrailingNewline: false };
}

function recordId(value: unknown): string {
  if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") {
    throw new Error("transcript record id is required");
  }
  return (value as { id: string }).id;
}

async function offloadContent(
  content: JsonValue | undefined,
  blobs: BlobStore,
  thresholdBytes: number,
): Promise<{ readonly contentHash: string; readonly preview?: JsonValue; readonly blobRef?: BlobReference }> {
  const serialized = JSON.stringify(content ?? null);
  const contentHash = sha256(serialized);
  if (Buffer.byteLength(serialized, "utf8") <= thresholdBytes) return { contentHash };
  const blobRef = await blobs.put(serialized, "application/json");
  return { contentHash, preview: toJsonValue({ preview: preview(serialized), omitted: true }), blobRef };
}

async function fileSize(path: string): Promise<number> {
  return stat(path).then(({ size }) => size).catch((error: unknown) => {
    if (isMissing(error)) return 0;
    throw error;
  });
}

function stablePathSegment(value: string): string {
  if (value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value)) return value;
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function preview(value: string): string {
  return value.length <= 1_000 ? value : `${value.slice(0, 1_000)}…`;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isDirectoryNotEmptyOrMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOTEMPTY" || error.code === "ENOENT" || error.code === "EEXIST");
}
