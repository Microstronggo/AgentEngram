import { inferMemoryClass, type MemoryRecord, type MemoryScope } from "../records/memory-record.js";

/** Mutable long-term store used for same-class lifecycle maintenance. */
export interface ConsolidationStore {
  list(scope: MemoryScope, projectId?: string): Promise<MemoryRecord[]>;
  put(record: MemoryRecord): Promise<void>;
}

/** Same-class comparison result used to keep, merge, supersede, or archive. */
export type MemoryRelationship =
  | { readonly kind: "distinct" }
  | { readonly kind: "duplicate"; readonly mergedContent?: string }
  | { readonly kind: "conflict"; readonly prefer: "left" | "right"; readonly correctedContent?: string };

/** Resolves semantic relationship without changing the memory's cognitive class. */
export interface MemoryRelationshipResolver {
  compare(left: MemoryRecord, right: MemoryRecord): Promise<MemoryRelationship>;
}

/** Scope and aging policy for one maintenance pass. */
export interface ConsolidationRequest {
  readonly scope: MemoryScope;
  readonly projectId?: string;
  readonly now?: Date;
  readonly staleAfterDays?: number;
  readonly archiveBelowImportance?: number;
}

/** Counts of lifecycle changes made by one consolidation pass. */
export interface ConsolidationReport {
  readonly scanned: number;
  readonly merged: number;
  readonly corrected: number;
  readonly expired: number;
  readonly aged: number;
  readonly changedIds: readonly string[];
}

/** Deterministic store mutation; semantic equivalence/conflict judgment stays model-pluggable. */
export class MemoryConsolidator {
  /**
   * @param store Durable record source and mutation target.
   * @param resolver Pluggable semantic duplicate/conflict judge.
   */
  public constructor(
    private readonly store: ConsolidationStore,
    private readonly resolver: MemoryRelationshipResolver = new ExactMemoryRelationshipResolver(),
  ) {}

  public async consolidate(request: ConsolidationRequest): Promise<ConsolidationReport> {
    const now = request.now ?? new Date();
    const records = await this.store.list(request.scope, request.projectId);
    const current = new Map(records.map(record => [record.id, record]));
    const changed = new Set<string>();
    let merged = 0;
    let corrected = 0;
    let expired = 0;
    let aged = 0;

    for (const record of current.values()) {
      if (record.status !== "active") continue;
      if (record.validUntil && Date.parse(record.validUntil) <= now.getTime()) {
        current.set(record.id, { ...record, status: "archived", updatedAt: now.toISOString() });
        changed.add(record.id);
        expired++;
      } else if (shouldAge(record, request, now)) {
        current.set(record.id, { ...record, status: "archived", updatedAt: now.toISOString() });
        changed.add(record.id);
        aged++;
      }
    }

    const active = [...current.values()].filter(record => record.status === "active");
    for (let leftIndex = 0; leftIndex < active.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex++) {
        const left = current.get(active[leftIndex]!.id)!;
        if (left.status !== "active") break;
        const right = current.get(active[rightIndex]!.id)!;
        if (right.status !== "active" || !comparable(left, right)) continue;
        const relationship = await this.resolver.compare(left, right);
        if (relationship.kind === "distinct") continue;
        const preferred = relationship.kind === "conflict"
          ? relationship.prefer === "left" ? left : right
          : preferRecord(left, right);
        const obsolete = preferred.id === left.id ? right : left;
        const combined: MemoryRecord = {
          ...preferred,
          content: relationship.kind === "conflict"
            ? relationship.correctedContent ?? preferred.content
            : relationship.mergedContent ?? preferred.content,
          tags: [...new Set([...preferred.tags, ...obsolete.tags])],
          sourceRefs: [...new Set([...preferred.sourceRefs, ...obsolete.sourceRefs])],
          updatedAt: now.toISOString(),
          supersedes: obsolete.id,
        };
        current.set(preferred.id, combined);
        current.set(obsolete.id, { ...obsolete, status: "superseded", updatedAt: now.toISOString() });
        changed.add(preferred.id);
        changed.add(obsolete.id);
        if (relationship.kind === "duplicate") merged++; else corrected++;
      }
    }

    for (const id of changed) await this.store.put(current.get(id)!);
    return { scanned: records.length, merged, corrected, expired, aged, changedIds: [...changed] };
  }
}

/** Dependency-free duplicate resolver used when no model-backed resolver is configured. */
export class ExactMemoryRelationshipResolver implements MemoryRelationshipResolver {
  public async compare(left: MemoryRecord, right: MemoryRecord): Promise<MemoryRelationship> {
    const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
    return normalize(left.content) === normalize(right.content)
      ? { kind: "duplicate" }
      : { kind: "distinct" };
  }
}

function comparable(left: MemoryRecord, right: MemoryRecord): boolean {
  return left.scope === right.scope &&
    left.projectId === right.projectId &&
    left.type === right.type &&
    inferMemoryClass(left) === inferMemoryClass(right);
}

function preferRecord(left: MemoryRecord, right: MemoryRecord): MemoryRecord {
  const quality = (record: MemoryRecord) => (record.confidence ?? 0.5) + (record.importance ?? 0.5);
  const delta = quality(left) - quality(right);
  return delta === 0 ? left.updatedAt >= right.updatedAt ? left : right : delta > 0 ? left : right;
}

function shouldAge(record: MemoryRecord, request: ConsolidationRequest, now: Date): boolean {
  const staleAfterDays = request.staleAfterDays ?? 180;
  const cutoff = request.archiveBelowImportance ?? 0.25;
  const lastUsefulAt = Date.parse(record.lastAccessedAt ?? record.updatedAt);
  return (record.importance ?? 0.5) < cutoff && now.getTime() - lastUsefulAt >= staleAfterDays * 86_400_000;
}
