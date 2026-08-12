import { createHash } from "node:crypto";
import {
  createMemoryRecord,
  createMemoryPartition,
  DefaultMemoryContentScanner,
  hashMemoryContent,
  inferMemoryClass,
  memoryPartitionKey,
  validateMemoryPartition,
  MemoryRecallService,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemoryType,
  type MemoryPartition,
  type RecallAudience,
  type MarkdownMemoryStore,
  type SqliteFtsMemoryIndex,
  type MemoryUsageSource,
} from "../memory/index.js";
import type { AgentEngramRuntime } from "./agent-engram.js";

/** Validated use-case input shared by native tools and MCP remember calls. */
export interface RememberInput {
  readonly id?: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly type: MemoryType;
  readonly scope: MemoryScope;
  readonly kind?: MemoryKind;
  readonly projectId?: string;
  readonly sourceRefs?: readonly string[];
  readonly confidence?: number;
  readonly importance?: number;
  /** Explicit identity dimensions; adapters should prefer this over scope-only routing. */
  readonly partition?: MemoryPartition;
  /** Stable caller key that makes transport retries idempotent across process restarts. */
  readonly idempotencyKey?: string;
  readonly assertedBy?: MemoryRecord["assertedBy"];
  readonly epistemicStatus?: MemoryRecord["epistemicStatus"];
}

/** Unified mutation command used by tools, MCP, formation, and future reflectors. */
export interface MemoryWriteCommand extends RememberInput {
  readonly operation?: "create" | "upsert" | "update" | "correct";
  readonly targetMemoryId?: string;
  readonly expectedRevision?: number;
}

/** Explicit write outcome keeps duplicate and optimistic conflicts observable to callers. */
export type MemoryWriteResult =
  | { readonly action: "created" | "updated"; readonly record: MemoryRecord }
  | { readonly action: "duplicate"; readonly record: MemoryRecord }
  | { readonly action: "superseded"; readonly record: MemoryRecord; readonly previous: MemoryRecord }
  | { readonly action: "conflict"; readonly record: MemoryRecord; readonly reason: string };

/** Shared use-case layer for native framework tools and MCP. */
export class MemoryApplicationService {
  /** Read-side service over the rebuildable FTS projection. */
  private readonly recall: MemoryRecallService;
  /** Optional runtime used only for context/session inspection. */
  private runtime: AgentEngramRuntime | undefined;
  /** Serializes conflicting mutations inside one runtime while revisions detect stale callers. */
  private writeTail: Promise<void> = Promise.resolve();
  /**
   * @param store Markdown source of truth.
   * @param index Rebuildable full-text search projection.
   * @param runtime Optional runtime inspection target.
   * @param scanner Safety gate applied before durable writes.
   */
  constructor(
    private readonly store: MarkdownMemoryStore,
    private readonly index: SqliteFtsMemoryIndex,
    runtime?: AgentEngramRuntime,
    private readonly scanner = new DefaultMemoryContentScanner(),
    usage?: MemoryUsageSource,
  ) {
    this.recall = new MemoryRecallService(index, usage);
    this.runtime = runtime;
  }

  /** Attaches diagnostics after circular runtime composition has completed. */
  attachRuntime(runtime: AgentEngramRuntime): this {
    this.runtime = runtime;
    return this;
  }

  /** Scans and persists an explicit long-term memory request. */
  async remember(input: RememberInput): Promise<MemoryRecord> {
    const result = await this.write({ ...input, operation: "upsert" });
    return result.record;
  }

  /** Runs every explicit mutation through one safety, dedupe, revision, and provenance boundary. */
  write(command: MemoryWriteCommand): Promise<MemoryWriteResult> {
    const partition = command.partition ?? createMemoryPartition(command.scope, {
      ...(command.projectId ? { projectId: command.projectId } : {}),
    });
    validateMemoryPartition(command.scope, partition);
    if (command.projectId && partition.projectId && command.projectId !== partition.projectId) {
      return Promise.reject(new Error("projectId does not match memory partition"));
    }
    return this.serializeWrite(() => this.store.withWriteLock(
      command.scope,
      partition.projectId ?? command.projectId,
      partition,
      () => this.writeUnlocked({ ...command, partition }),
    ));
  }

  /** Updates an existing record without losing its creation time or provenance. */
  update(command: MemoryWriteCommand & { readonly targetMemoryId: string }): Promise<MemoryWriteResult> {
    return this.write({ ...command, operation: "update" });
  }

  /** Creates a correction and preserves the superseded record for temporal history. */
  correct(command: MemoryWriteCommand & { readonly targetMemoryId: string }): Promise<MemoryWriteResult> {
    return this.write({ ...command, operation: "correct", type: "feedback", kind: "correction", epistemicStatus: "corrected" });
  }

  /** Persists an already validated Engine record to Markdown truth and FTS projection. */
  async putRecord(record: MemoryRecord): Promise<void> {
    await this.store.put(record);
    this.index.upsert(record);
  }

  /** Searches through the same reranker used for model-context recall. */
  search(input: { readonly text: string; readonly projectId?: string; readonly scope?: MemoryScope; readonly limit?: number; readonly audience?: RecallAudience }) {
    return this.recall.recall({
      query: input.text,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.limit === undefined ? {} : { maxResults: input.limit }),
      ...(input.audience === undefined ? {} : { audience: input.audience }),
    }).memories.map(({ record, score }) => ({ record, rank: -score }));
  }

  read(scope: MemoryScope, id: string, projectId?: string, partition?: MemoryPartition): Promise<MemoryRecord | null> {
    return this.store.get(scope, id, projectId, partition);
  }

  /** Removes Markdown truth first and then its rebuildable search projection. */
  async forget(scope: MemoryScope, id: string, projectId?: string, partition?: MemoryPartition): Promise<boolean> {
    const existing = await this.store.get(scope, id, projectId, partition);
    if (!existing) return false;
    await this.store.remove(scope, id, projectId, existing.partition);
    this.index.remove(existing);
    return true;
  }

  feedback(input: Omit<RememberInput, "type" | "kind"> & { readonly targetMemoryId?: string }): Promise<MemoryRecord> {
    if (input.targetMemoryId) {
      return this.correct({ ...input, targetMemoryId: input.targetMemoryId, type: "feedback", kind: "correction" })
        .then((result) => result.record);
    }
    return this.remember({ ...input, type: "feedback", kind: "correction", epistemicStatus: "corrected" });
  }

  inspectContext(sessionId?: string): unknown {
    if (!this.runtime) return { available: false };
    return this.runtime.inspectDiagnostics(sessionId);
  }

  private async writeUnlocked(command: MemoryWriteCommand): Promise<MemoryWriteResult> {
    const safety = await this.scanner.scan(command);
    if (!safety.allowed) throw new Error(safety.reason);
    const partition = command.partition!;
    const projectId = partition.projectId ?? command.projectId;
    const operation = command.operation ?? "upsert";
    const targetId = command.targetMemoryId ?? (operation === "update" || operation === "correct" ? command.id : undefined);
    const target = targetId ? await this.store.get(command.scope, targetId, projectId, partition) : null;
    if ((operation === "update" || operation === "correct") && !target) {
      throw new Error(`${operation} target memory does not exist: ${targetId ?? "unknown"}`);
    }
    if (target && command.expectedRevision !== undefined && target.revision !== command.expectedRevision) {
      return { action: "conflict", record: target, reason: `expected revision ${command.expectedRevision}, found ${target.revision}` };
    }

    const id = command.id ?? (command.idempotencyKey
      ? stableWriteId(command.idempotencyKey, partition)
      : operation === "update" ? target!.id : crypto.randomUUID());
    const sameId = await this.store.get(command.scope, id, projectId, partition);
    const contentHash = hashMemoryContent(command.content);
    if (sameId && sameId.contentHash === contentHash) return { action: "duplicate", record: sameId };
    if (sameId && operation === "create") return { action: "conflict", record: sameId, reason: "memory id already exists" };

    const duplicate = (await this.store.list(command.scope, projectId)).find((record) =>
      record.status === "active" &&
      record.contentHash === contentHash &&
      record.type === command.type &&
      inferMemoryClass(record) === inferMemoryClass(command) &&
      memoryPartitionKey(record.partition) === memoryPartitionKey(partition));
    if (duplicate && duplicate.id !== target?.id) return { action: "duplicate", record: duplicate };

    const base = operation === "update" ? target : sameId;
    const record = createMemoryRecord({
      id: base?.id ?? id,
      name: command.name,
      description: command.description,
      content: command.content,
      type: command.type,
      scope: command.scope,
      partition,
      revision: (base?.revision ?? 0) + 1,
      sourceRefs: [...new Set([...(base?.sourceRefs ?? []), ...(command.sourceRefs ?? [])])],
      ...(base ? { createdAt: base.createdAt } : {}),
      ...(command.kind === undefined ? {} : { kind: command.kind }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(command.confidence === undefined ? {} : { confidence: command.confidence }),
      ...(command.importance === undefined ? {} : { importance: command.importance }),
      ...(command.assertedBy === undefined ? {} : { assertedBy: command.assertedBy }),
      ...(command.epistemicStatus === undefined ? {} : { epistemicStatus: command.epistemicStatus }),
      ...(operation === "correct" ? { supersedes: target!.id } : {}),
    });

    if (operation === "correct") {
      const previous = { ...target!, status: "superseded" as const, revision: target!.revision + 1, updatedAt: new Date().toISOString() };
      await this.putRecord(previous);
      try {
        await this.putRecord(record);
      } catch (error) {
        // The record Markdown may have been committed before its FTS projection
        // failed. Remove that partial truth before restoring the prior record.
        await this.store.remove(record.scope, record.id, projectId, partition).catch(() => undefined);
        try { this.index.remove(record); } catch { /* Best-effort projection cleanup; Markdown remains authoritative. */ }
        await this.putRecord(target!);
        throw error;
      }
      return { action: "superseded", record, previous };
    }
    await this.putRecord(record);
    return { action: base ? "updated" : "created", record };
  }

  private serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation, operation);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function stableWriteId(idempotencyKey: string, partition: MemoryPartition): string {
  const digest = createHash("sha256").update(`${memoryPartitionKey(partition)}\0${idempotencyKey}`).digest("hex").slice(0, 24);
  return `mem_${digest}`;
}
