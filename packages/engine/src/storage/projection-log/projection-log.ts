import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256, stableStringify, type JsonValue } from "../serialization.js";

/** One hash-chained context projection decision persisted in append order. */
export interface ProjectionLogRecord {
  readonly schemaVersion: 1;
  readonly seq: number;
  readonly previousHash: string | null;
  readonly timestamp: string;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly hash: string;
}

/** Valid log prefix plus explicit corruption metadata when validation stops. */
export type ProjectionLogReadResult =
  | { readonly status: "ok"; readonly records: readonly ProjectionLogRecord[] }
  | {
      readonly status: "corrupt";
      readonly records: readonly ProjectionLogRecord[];
      readonly line: number;
      readonly reason: string;
    };

type UnhashedRecord = Omit<ProjectionLogRecord, "hash">;

/** Process-wide path queues synchronize independently constructed log handles. */
const appendQueues = new Map<string, Promise<unknown>>();

/** Append-only hash-chained decision log used to validate checkpoint watermarks. */
export class ProjectionLog {
  /** JSONL file containing the projection chain. */
  readonly #path: string;
  public constructor(path: string) {
    this.#path = path;
  }

  public read(): Promise<ProjectionLogReadResult> {
    return readProjectionLog(this.#path);
  }

  /** Serializes appends within this process and fsyncs before resolving. */
  public append(kind: string, payload: JsonValue, timestamp = new Date().toISOString()): Promise<ProjectionLogRecord> {
    const previous = appendQueues.get(this.#path) ?? Promise.resolve();
    const operation = previous.then(() => appendProjectionRecord(this.#path, kind, payload, timestamp));
    const settled = operation.catch(() => undefined);
    appendQueues.set(this.#path, settled);
    void settled.finally(() => {
      if (appendQueues.get(this.#path) === settled) appendQueues.delete(this.#path);
    });
    return operation;
  }
}

/** Appends and fsyncs one record after validating the complete existing chain. */
export async function appendProjectionRecord(
  path: string,
  kind: string,
  payload: JsonValue,
  timestamp = new Date().toISOString(),
): Promise<ProjectionLogRecord> {
  const current = await readProjectionLog(path);
  if (current.status === "corrupt") {
    throw new Error(`Cannot append to corrupt projection log at line ${current.line}: ${current.reason}`);
  }
  const previous = current.records.at(-1);
  const unhashed: UnhashedRecord = {
    schemaVersion: 1,
    seq: (previous?.seq ?? 0) + 1,
    previousHash: previous?.hash ?? null,
    timestamp,
    kind,
    payload,
  };
  const record: ProjectionLogRecord = { ...unhashed, hash: recordHash(unhashed) };

  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "a", 0o600);
  try {
    await file.write(`${stableStringify(record as unknown as JsonValue)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  return record;
}

/** Reads the longest valid log prefix and verifies sequence numbers and hashes. */
export async function readProjectionLog(path: string): Promise<ProjectionLogReadResult> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { status: "ok", records: [] };
    throw error;
  }

  const records: ProjectionLogRecord[] = [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) {
      return corrupt(records, index + 1, "empty JSONL record");
    }
    let record: ProjectionLogRecord;
    try {
      record = JSON.parse(line) as ProjectionLogRecord;
    } catch {
      return corrupt(records, index + 1, "invalid JSON");
    }
    if (!isProjectionLogRecord(record)) {
      return corrupt(records, index + 1, "malformed projection record");
    }
    const expectedSeq = index + 1;
    const expectedPreviousHash = records.at(-1)?.hash ?? null;
    if (record.schemaVersion !== 1) return corrupt(records, index + 1, "unsupported schema version");
    if (record.seq !== expectedSeq) return corrupt(records, index + 1, "non-contiguous sequence");
    if (record.previousHash !== expectedPreviousHash) return corrupt(records, index + 1, "broken hash chain");
    const { hash, ...unhashed } = record;
    if (hash !== recordHash(unhashed)) return corrupt(records, index + 1, "record hash mismatch");
    records.push(record);
  }
  return { status: "ok", records };
}

function isProjectionLogRecord(value: unknown): value is ProjectionLogRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<ProjectionLogRecord>;
  return (
    record.schemaVersion === 1 &&
    Number.isSafeInteger(record.seq) &&
    typeof record.timestamp === "string" &&
    typeof record.kind === "string" &&
    (record.previousHash === null || typeof record.previousHash === "string") &&
    typeof record.hash === "string" &&
    record.payload !== undefined
  );
}

function recordHash(record: UnhashedRecord): string {
  return sha256(record as unknown as JsonValue);
}

function corrupt(
  records: readonly ProjectionLogRecord[],
  line: number,
  reason: string,
): ProjectionLogReadResult {
  return { status: "corrupt", records, line, reason };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
