import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { emptyCellFormationState, type CellFormationState } from "./cell-formation-state.js";

/** Composite key that isolates durable Cell state per host session and thread. */
export interface CellFormationStateIdentity {
  readonly sessionId: string;
  readonly threadId: string;
}

/** Atomic persistence boundary for Cell cursor, tail, outbox, and dead letters. */
export interface CellFormationStateRepository {
  load(identity: CellFormationStateIdentity): Promise<CellFormationState>;
  save(identity: CellFormationStateIdentity, state: CellFormationState): Promise<void>;
}

/** Atomic JSON repository for per-thread Cell tail, cursor, and pending outbox state. */
export class FileCellFormationStateRepository implements CellFormationStateRepository {
  /** @param rootDir Project-scoped AgentEngram directory containing threads/. */
  public constructor(
    private readonly rootDir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async load(identity: CellFormationStateIdentity): Promise<CellFormationState> {
    const path = this.pathFor(identity);
    const text = await readFile(path, "utf8").catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (text === undefined) return emptyCellFormationState(this.clock());
    const parsed = JSON.parse(text) as unknown;
    if (!isCellFormationState(parsed)) throw new Error(`invalid Cell formation state: ${path}`);
    // Schema version remains 1; newly added reliability fields are additive so
    // existing installations can be upgraded without a migration job.
    return { ...parsed, deadLetters: parsed.deadLetters ?? [] };
  }

  public async save(identity: CellFormationStateIdentity, state: CellFormationState): Promise<void> {
    if (!isCellFormationState(state)) throw new Error("invalid Cell formation state");
    const path = this.pathFor(identity);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await file.sync();
      await file.close();
      await rename(temporary, path);
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private pathFor(identity: CellFormationStateIdentity): string {
    return join(
      this.rootDir,
      "threads",
      stablePathSegment(identity.sessionId),
      stablePathSegment(identity.threadId),
      "formation-state.json",
    );
  }
}

function isCellFormationState(value: unknown): value is CellFormationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (state.schemaVersion !== 1 || typeof state.updatedAt !== "string") return false;
  if (state.transcriptCursor !== undefined && typeof state.transcriptCursor !== "string") return false;
  if (!Array.isArray(state.tail) || !state.tail.every(isBoundaryEntry)) return false;
  if (!Array.isArray(state.pendingCells) || !state.pendingCells.every(isPendingCell)) return false;
  if (state.deadLetters !== undefined && (!Array.isArray(state.deadLetters) || !state.deadLetters.every(isDeadLetterCell))) return false;
  return true;
}

function isBoundaryEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && typeof entry.role === "string" && typeof entry.text === "string";
}

function isPendingCell(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pending = value as Record<string, unknown>;
  if (pending.stage !== "episode" && pending.stage !== "derived") return false;
  if (typeof pending.attempts !== "number" || !Number.isInteger(pending.attempts) || pending.attempts < 0) return false;
  if (pending.derivedCursor !== undefined && (typeof pending.derivedCursor !== "number" || !Number.isInteger(pending.derivedCursor) || pending.derivedCursor < 0)) return false;
  if (pending.derivedCandidates !== undefined && !Array.isArray(pending.derivedCandidates)) return false;
  if (pending.nextRetryAt !== undefined && typeof pending.nextRetryAt !== "string") return false;
  if (!pending.cell || typeof pending.cell !== "object" || Array.isArray(pending.cell)) return false;
  const cell = pending.cell as Record<string, unknown>;
  return typeof cell.id === "string" && typeof cell.text === "string" && Array.isArray(cell.sourceEntryIds);
}

function isDeadLetterCell(value: unknown): boolean {
  return isPendingCell(value) && typeof (value as Record<string, unknown>).deadLetteredAt === "string";
}

function stablePathSegment(value: string): string {
  if (value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value)) return value;
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
