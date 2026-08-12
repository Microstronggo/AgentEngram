import Database from "better-sqlite3";
import { createMemoryRecord, inferMemoryClass, type MemoryClass, type MemoryRecord, type MemoryScope, type MemoryType } from "../records/memory-record.js";
import { createMemoryPartition, isPartitionVisible, memoryPartitionKey, type RecallAudience } from "../records/memory-partition.js";

/** Candidate-generation query over the rebuildable SQLite FTS projection. */
export interface MemorySearchQuery {
  /** Natural-language query text converted into a safe FTS5 expression. */
  text: string;
  limit?: number;
  scope?: MemoryScope;
  type?: MemoryType;
  memoryClass?: MemoryClass;
  projectId?: string;
  includeGlobal?: boolean;
  /** Full caller identity. When supplied it replaces legacy project/global visibility. */
  audience?: RecallAudience;
}

/** FTS candidate paired with its raw BM25 rank. */
export interface MemorySearchResult {
  /** Full durable memory record reconstructed from the projection payload. */
  record: MemoryRecord;
  /** Raw FTS5 bm25 rank; lower is better before MemoryRecallService reranking. */
  rank: number;
}

/** SQLite row shape before JSON metadata is decoded into MemoryRecord. */
interface MemoryRow {
  payload: string;
  rank: number;
}

/** Closeable FTS5 projection; every row can be rebuilt from Markdown records. */
export class SqliteFtsMemoryIndex {
  /** Synchronous local SQLite connection owned by this index instance. */
  private readonly database: Database.Database;

  /** @param path SQLite database file path. */
  public constructor(path: string) {
    this.database = new Database(path);
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        memory_key TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        scope TEXT NOT NULL,
        type TEXT NOT NULL,
        memory_class TEXT,
        status TEXT NOT NULL,
        project_id TEXT,
        partition_key TEXT,
        payload TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        memory_key UNINDEXED,
        name,
        description,
        content,
        tags
      );
    `);
    ensureMemoryClassColumn(this.database);
    ensureColumn(this.database, "partition_key", "TEXT");
  }

  public upsert(record: MemoryRecord): void {
    const projectScoped = record.scope === "project" || record.scope === "local";
    const partition = projectScoped && record.projectId !== record.partition?.projectId
      ? createMemoryPartition(record.scope, { ...(record.partition ?? {}), projectId: record.projectId! })
      : record.partition;
    record = createMemoryRecord({ ...record, ...(partition ? { partition } : {}) });
    assertProjectIdentity(record);
    const key = memoryKey(record);
    // Base metadata and FTS content must advance atomically.
    const transaction = this.database.transaction(() => {
      // Remove the pre-partition V1 key during lazy migration so an existing
      // index cannot return both the legacy and partition-aware projection.
      const legacyKey = legacyMemoryKey(record);
      if (legacyKey !== key) {
        this.database.prepare("DELETE FROM memories_fts WHERE memory_key = ?").run(legacyKey);
        this.database.prepare("DELETE FROM memories WHERE memory_key = ?").run(legacyKey);
      }
      this.database.prepare("DELETE FROM memories_fts WHERE memory_key = ?").run(key);
      this.database
        .prepare(`INSERT INTO memories(memory_key, id, scope, type, memory_class, status, project_id, partition_key, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(memory_key) DO UPDATE SET
            id = excluded.id,
            scope = excluded.scope,
            type = excluded.type,
            memory_class = excluded.memory_class,
            status = excluded.status,
            project_id = excluded.project_id,
            partition_key = excluded.partition_key,
            payload = excluded.payload`)
        .run(key, record.id, record.scope, record.type, inferMemoryClass(record), record.status, record.projectId ?? null,
          memoryPartitionKey(record.partition), JSON.stringify(record));
      this.database
        .prepare("INSERT INTO memories_fts(memory_key, name, description, content, tags) VALUES (?, ?, ?, ?, ?)")
        .run(key, record.name, record.description, record.content, searchableTags(record));
    });
    transaction();
  }

  public remove(identity: Pick<MemoryRecord, "id" | "scope" | "projectId">): void {
    assertProjectIdentity(identity);
    const key = memoryKey(identity);
    const transaction = this.database.transaction(() => {
      this.database.prepare("DELETE FROM memories_fts WHERE memory_key = ?").run(key);
      this.database.prepare("DELETE FROM memories WHERE memory_key = ?").run(key);
      const legacyKey = legacyMemoryKey(identity);
      this.database.prepare("DELETE FROM memories_fts WHERE memory_key = ?").run(legacyKey);
      this.database.prepare("DELETE FROM memories WHERE memory_key = ?").run(legacyKey);
    });
    transaction();
  }

  /** Clears only the rebuildable memory projection while preserving shared usage tables. */
  public clear(): void {
    const transaction = this.database.transaction(() => {
      this.database.prepare("DELETE FROM memories_fts").run();
      this.database.prepare("DELETE FROM memories").run();
    });
    transaction();
  }

  /** Returns the number of projected records for diagnostics and rebuild verification. */
  public count(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number };
    return row.count;
  }

  public search(query: MemorySearchQuery): MemorySearchResult[] {
    const ftsQueries = toFtsQueries(query.text);
    if (ftsQueries.length === 0) return [];
    const limit = Math.max(1, Math.min(query.limit ?? 10, 500));
    const selected = new Map<string, MemorySearchResult>();
    // Run a content-token query first and fall back to the full query only when
    // needed. This keeps repeated speaker/user names from drowning out rare
    // content words in transcript-derived memory.
    for (const ftsQuery of ftsQueries) {
      for (const result of this.searchOnce(query, ftsQuery, query.audience ? Math.min(500, limit * 5) : limit)) {
        if (query.audience && !isPartitionVisible(result.record.scope, result.record.partition, query.audience)) continue;
        selected.set(memoryKey(result.record), result);
        if (selected.size >= limit) return [...selected.values()];
      }
    }
    return [...selected.values()];
  }

  public getByIds(ids: readonly string[], options: {
    readonly projectId?: string;
    readonly includeGlobal?: boolean;
    readonly audience?: RecallAudience;
  } = {}): MemoryRecord[] {
    // Parent expansion is an identity lookup, not a lexical search. Keep the
    // same project/global visibility rules as normal FTS recall.
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return [];
    const clauses = [`id IN (${uniqueIds.map(() => "?").join(", ")})`, "status = 'active'"];
    const parameters: unknown[] = [...uniqueIds];
    appendProjectClauses(clauses, parameters, options.projectId, options.includeGlobal);
    const rows = this.database
      .prepare(`SELECT payload, 0 AS rank FROM memories WHERE ${clauses.join(" AND ")}`)
      .all(...parameters) as MemoryRow[];
    return rows.map(decodeMemoryRow)
      .filter((record) => !options.audience || isPartitionVisible(record.scope, record.partition, options.audience));
  }

  public searchByParentIds(parentIds: readonly string[], query: MemorySearchQuery): MemorySearchResult[] {
    // V1 keeps parent edges inside the JSON projection payload. The bounded
    // in-memory filter avoids a second SQL schema while preserving the option
    // to rebuild this entire table from Markdown truth.
    const uniqueParentIds = [...new Set(parentIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueParentIds.length === 0) return [];
    const limit = Math.max(1, Math.min(query.limit ?? 10, 500));
    const clauses = ["status = 'active'"];
    const parameters: unknown[] = [];
    appendProjectClauses(clauses, parameters, query.projectId, query.includeGlobal);
    const rows = this.database
      .prepare(`SELECT payload, 0 AS rank FROM memories WHERE ${clauses.join(" AND ")}`)
      .all(...parameters) as MemoryRow[];
    const queryTokens = new Set(tokenizeFts(query.text).map((token) => token.value));
    return rows
      .map((row) => ({ record: decodeMemoryRow(row), rank: row.rank }))
      .filter(({ record }) => !query.audience || isPartitionVisible(record.scope, record.partition, query.audience))
      .filter(({ record }) => record.parentMemoryIds?.some((parentId) => uniqueParentIds.includes(parentId)))
      .filter(({ record }) => !query.memoryClass || inferMemoryClass(record) === query.memoryClass)
      .filter(({ record }) => !query.scope || record.scope === query.scope)
      .filter(({ record }) => !query.type || record.type === query.type)
      .map((result) => ({
        ...result,
        rank: -childLexicalHits(queryTokens, result.record),
      }))
      .sort((left, right) => left.rank - right.rank || right.record.updatedAt.localeCompare(left.record.updatedAt))
      .slice(0, limit);
  }

  private searchOnce(query: MemorySearchQuery, ftsQuery: string, limit: number): MemorySearchResult[] {
    const clauses = ["memories_fts MATCH ?", "m.status = 'active'"];
    const parameters: unknown[] = [ftsQuery];
    if (query.scope) {
      clauses.push("m.scope = ?");
      parameters.push(query.scope);
    }
    if (query.type) {
      clauses.push("m.type = ?");
      parameters.push(query.type);
    }
    if (query.memoryClass) {
      clauses.push("m.memory_class = ?");
      parameters.push(query.memoryClass);
    }
    if (query.audience) appendAudienceClause(clauses, parameters, query.audience, "m");
    if (query.projectId && query.includeGlobal !== false) {
      clauses.push("(m.project_id = ? OR m.project_id IS NULL)");
      parameters.push(query.projectId);
    } else if (query.projectId) {
      clauses.push("m.project_id = ?");
      parameters.push(query.projectId);
    } else {
      clauses.push("m.project_id IS NULL");
    }
    parameters.push(limit);

    const rows = this.database
      .prepare(
        `SELECT m.payload, bm25(memories_fts) AS rank
         FROM memories_fts
         JOIN memories m ON m.memory_key = memories_fts.memory_key
         WHERE ${clauses.join(" AND ")}
         ORDER BY rank ASC
         LIMIT ?`,
      )
      .all(...parameters) as MemoryRow[];
    return rows.map((row) => ({ record: decodeMemoryRow(row), rank: row.rank }));
  }

  public close(): void {
    this.database.close();
  }
}

function appendProjectClauses(clauses: string[], parameters: unknown[], projectId: string | undefined, includeGlobal = true): void {
  if (projectId && includeGlobal !== false) {
    clauses.push("(project_id = ? OR project_id IS NULL)");
    parameters.push(projectId);
  } else if (projectId) {
    clauses.push("project_id = ?");
    parameters.push(projectId);
  } else {
    clauses.push("project_id IS NULL");
  }
}

function appendAudienceClause(
  clauses: string[],
  parameters: unknown[],
  audience: RecallAudience,
  alias: string,
): void {
  const partition = `json_extract(${alias}.payload, '$.partition`;
  const visibility: string[] = [];
  const visibilityParameters: unknown[] = [];
  if (audience.userId) {
    visibility.push(`(${alias}.scope = 'user' AND ${partition}.userId') = ?)`);
    visibilityParameters.push(audience.userId);
  }
  if (audience.agentId) {
    visibility.push(`(${alias}.scope = 'agent' AND ${partition}.agentId') = ?)`);
    visibilityParameters.push(audience.agentId);
  }
  if (audience.teamIds?.length) {
    visibility.push(`(${alias}.scope = 'team' AND ${partition}.teamId') IN (${audience.teamIds.map(() => "?").join(", ")}))`);
    visibilityParameters.push(...audience.teamIds);
  }
  if (audience.projectId) {
    visibility.push(`(${alias}.scope = 'project' AND ${partition}.projectId') = ?)`);
    visibilityParameters.push(audience.projectId);
  }
  if (audience.projectId && audience.worktreeId) {
    visibility.push(`(${alias}.scope = 'local' AND ${partition}.projectId') = ? AND ${partition}.worktreeId') = ?)`);
    visibilityParameters.push(audience.projectId, audience.worktreeId);
  }
  if (visibility.length === 0) {
    clauses.push("0 = 1");
    return;
  }
  clauses.push(`(${partition}.appId') IS NULL OR ${partition}.appId') = ?)`);
  parameters.push(audience.appId ?? null);
  clauses.push(`(${partition}.namespace') IS NULL OR ${partition}.namespace') = ?)`);
  parameters.push(audience.namespace ?? null);
  clauses.push(`(${visibility.join(" OR ")})`);
  parameters.push(...visibilityParameters);
}

function memoryKey(identity: Pick<MemoryRecord, "id" | "scope" | "projectId"> & Partial<Pick<MemoryRecord, "partition">>): string {
  // The project id is part of the storage identity so identical logical ids can
  // coexist safely across worktrees/projects.
  return `${identity.scope}\u0000${identity.partition ? memoryPartitionKey(identity.partition) : identity.projectId ?? ""}\u0000${identity.id}`;
}

function legacyMemoryKey(identity: Pick<MemoryRecord, "id" | "scope" | "projectId">): string {
  return `${identity.scope}\u0000${identity.projectId ?? ""}\u0000${identity.id}`;
}

function assertProjectIdentity(identity: Pick<MemoryRecord, "scope" | "projectId">): void {
  if (["project", "local", "team"].includes(identity.scope) && !identity.projectId) {
    throw new Error(`${identity.scope} memory requires projectId`);
  }
}

function ensureMemoryClassColumn(database: Database.Database): void {
  // Older local indexes can be opened after adding typed memory; they are
  // projections, so a lightweight migration is enough.
  const columns = database.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "memory_class")) {
    database.exec("ALTER TABLE memories ADD COLUMN memory_class TEXT");
  }
}

function ensureColumn(database: Database.Database, name: string, type: string): void {
  const columns = database.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === name)) database.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type}`);
}

function toFtsQueries(text: string): readonly string[] {
  const tokens = tokenizeFts(text);
  if (tokens.length === 0) return [];
  const contentTokens = tokens.filter((token) => !token.properName);
  // Proper names are useful fallback signals, but content words are normally
  // more selective for single-hop and temporal benchmark questions.
  const primaryTokens = contentTokens.length >= 2 ? contentTokens : tokens;
  const primary = renderFtsQuery(primaryTokens);
  const fallback = renderFtsQuery(tokens);
  return primary === fallback ? [primary] : [primary, fallback];
}

function tokenizeFts(text: string): ReadonlyArray<{ readonly value: string; readonly properName: boolean }> {
  return (text.match(/[\p{L}\p{N}_']+/gu) ?? [])
    .flatMap((rawToken) => {
      const normalized = rawToken
        .toLowerCase()
        .replace(/'s$/u, "")
        .replace(/[^\p{L}\p{N}_]/gu, "");
      if (normalized.length <= 1 || STOPWORDS.has(normalized)) return [];
      return [{ value: normalized, properName: /^[A-Z][a-z]+(?:'s)?$/u.test(rawToken) }];
    });
}

function renderFtsQuery(tokens: ReadonlyArray<{ readonly value: string }>): string {
  // Prefix terms preserve cheap lexical flexibility such as paint -> painting
  // while the token sanitizer prevents punctuation-driven FTS syntax errors.
  return [...new Set(tokens.map((token) => token.value))]
    .map((token) => `${token}*`)
    .join(" OR ");
}

function childLexicalHits(queryTokens: ReadonlySet<string>, record: MemoryRecord): number {
  if (queryTokens.size === 0) return 0;
  const textTokens = new Set(tokenizeFts(`${record.name} ${record.description} ${record.content}`).map((token) => token.value));
  let hits = 0;
  for (const token of queryTokens) if (textTokens.has(token)) hits++;
  return hits;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "did", "do", "does", "for", "from",
  "had", "has", "have", "he", "her", "hers", "him", "his", "how", "i", "in", "is", "it", "its", "me",
  "my", "of", "on", "or", "our", "she", "that", "the", "their", "them", "they", "this", "to", "was",
  "we", "were", "what", "when", "where", "which", "who", "whom", "why", "with", "would", "you", "your",
]);

function searchableTags(record: MemoryRecord): string {
  return [
    ...record.tags,
    record.kind ?? "",
    inferMemoryClass(record),
    // Keep high-cardinality or high-frequency metadata out of broad OR FTS
    // matching. Relations keep only predicate/object because subjects are often
    // repeated speaker names in transcript-derived memory.
    ...(record.relations ?? []).flatMap((relation) => [relation.predicate, relation.object]),
  ].join(" ");
}

function decodeMemoryRow(row: MemoryRow): MemoryRecord {
  return createMemoryRecord(JSON.parse(row.payload) as MemoryRecord);
}
