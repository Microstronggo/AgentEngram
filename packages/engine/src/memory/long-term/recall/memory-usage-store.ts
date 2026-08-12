import Database from "better-sqlite3";
import { memoryPartitionKey } from "../records/memory-partition.js";
import type { MemoryRecord } from "../records/memory-record.js";

/** Rebuild-independent interaction signals; surfacing alone remains a deliberately weak signal. */
export interface MemoryUsageStats {
  readonly memoryId: string;
  readonly surfacedCount: number;
  readonly selectedCount: number;
  readonly usedCount: number;
  readonly correctedCount: number;
  readonly lastSurfacedAt?: string;
  readonly lastUsedAt?: string;
}

export interface MemoryUsageSource {
  get(memoryId: string): MemoryUsageStats | undefined;
  markSurfaced(memoryIds: readonly string[], at: Date): void;
}

/** Partition-qualified key preventing identical ids from sharing feedback signals. */
export function memoryUsageKey(record: Pick<MemoryRecord, "id" | "partition">): string {
  return `${memoryPartitionKey(record.partition)}\u0000${record.id}`;
}

/** SQLite projection for recall feedback that avoids rewriting Markdown on every prompt. */
export class SqliteMemoryUsageStore implements MemoryUsageSource {
  private readonly database: Database.Database;

  public constructor(path: string) {
    this.database = new Database(path);
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`CREATE TABLE IF NOT EXISTS memory_usage (
      memory_id TEXT PRIMARY KEY,
      surfaced_count INTEGER NOT NULL DEFAULT 0,
      selected_count INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      corrected_count INTEGER NOT NULL DEFAULT 0,
      last_surfaced_at TEXT,
      last_used_at TEXT
    )`);
  }

  public get(memoryId: string): MemoryUsageStats | undefined {
    const row = this.database.prepare("SELECT * FROM memory_usage WHERE memory_id = ?").get(memoryId) as UsageRow | undefined;
    return row ? decode(row) : undefined;
  }

  public markSurfaced(memoryIds: readonly string[], at: Date): void {
    const timestamp = at.toISOString();
    const update = this.database.prepare(`INSERT INTO memory_usage(memory_id, surfaced_count, last_surfaced_at)
      VALUES (?, 1, ?) ON CONFLICT(memory_id) DO UPDATE SET
      surfaced_count = surfaced_count + 1, last_surfaced_at = excluded.last_surfaced_at`);
    this.database.transaction(() => {
      for (const id of new Set(memoryIds)) update.run(id, timestamp);
    })();
  }

  /** Strong positive signal recorded only when a host confirms the memory affected its work. */
  public markUsed(memoryId: string, at = new Date()): void {
    this.increment(memoryId, "used_count", "last_used_at", at);
  }

  public markSelected(memoryId: string, at = new Date()): void {
    this.increment(memoryId, "selected_count", undefined, at);
  }

  public markCorrected(memoryId: string, at = new Date()): void {
    this.increment(memoryId, "corrected_count", undefined, at);
  }

  public close(): void { this.database.close(); }

  private increment(memoryId: string, column: "used_count" | "selected_count" | "corrected_count", timeColumn: "last_used_at" | undefined, at: Date): void {
    const timestamp = at.toISOString();
    this.database.prepare(`INSERT INTO memory_usage(memory_id, ${column}${timeColumn ? `, ${timeColumn}` : ""})
      VALUES (?, 1${timeColumn ? ", ?" : ""}) ON CONFLICT(memory_id) DO UPDATE SET
      ${column} = ${column} + 1${timeColumn ? `, ${timeColumn} = excluded.${timeColumn}` : ""}`)
      .run(...(timeColumn ? [memoryId, timestamp] : [memoryId]));
  }
}

interface UsageRow {
  memory_id: string; surfaced_count: number; selected_count: number; used_count: number;
  corrected_count: number; last_surfaced_at: string | null; last_used_at: string | null;
}

function decode(row: UsageRow): MemoryUsageStats {
  return {
    memoryId: row.memory_id, surfacedCount: row.surfaced_count, selectedCount: row.selected_count,
    usedCount: row.used_count, correctedCount: row.corrected_count,
    ...(row.last_surfaced_at ? { lastSurfacedAt: row.last_surfaced_at } : {}),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
  };
}
