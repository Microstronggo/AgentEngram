import { inferMemoryClass, type MemoryRecord } from "../records/memory-record.js";
import type {
  DuplicateResolver,
  MemoryCandidate,
  MemoryObservation,
  SignificanceEvaluator,
} from "./memory-formation.js";

/** Active-memory lookup used by deterministic duplicate/conflict policy. */
export interface DuplicateMemorySource {
  list(scope: MemoryCandidate["scope"], projectId?: string): Promise<MemoryRecord[]>;
}

/** Conservative significance policy used by installable automatic Cell formation. */
export class DefaultSignificanceEvaluator implements SignificanceEvaluator {
  public async evaluate(candidate: MemoryCandidate): Promise<{ readonly save: boolean; readonly importance: number; readonly reason?: string }> {
    const content = candidate.content.trim();
    if (content.length < 12) return { save: false, importance: 0, reason: "content-too-short" };
    if (candidate.confidence !== undefined && candidate.confidence < 0.5) {
      return { save: false, importance: candidate.confidence, reason: "low-confidence" };
    }
    const memoryClass = inferMemoryClass(candidate);
    const classImportance = memoryClass === "procedural"
      ? 0.85
      : memoryClass === "factual"
        ? 0.75
        : memoryClass === "semantic"
          ? 0.7
          : 0.65;
    return { save: true, importance: Math.max(classImportance, candidate.confidence ?? 0) };
  }
}

/** Exact class-aware duplicate gate; semantic consolidation remains a separate job. */
export class DefaultDuplicateResolver implements DuplicateResolver {
  public constructor(private readonly source: DuplicateMemorySource) {}

  public async resolve(candidate: MemoryCandidate): Promise<
    | { readonly action: "write" }
    | { readonly action: "skip"; readonly existingId: string }
  > {
    // Episodes preserve chronology even when narratives happen to match. Their
    // deterministic cell-derived ids make retries idempotent at the writer.
    if (inferMemoryClass(candidate) === "episodic") return { action: "write" };
    const normalized = normalize(candidate.content);
    const records = await this.source.list(candidate.scope, projectIdFor(candidate));
    const duplicate = records.find((record) => record.status === "active" &&
      record.type === candidate.type &&
      inferMemoryClass(record) === inferMemoryClass(candidate) &&
      normalize(record.content) === normalized);
    return duplicate ? { action: "skip", existingId: duplicate.id } : { action: "write" };
  }
}

/** Automatic formation may write only user or project memory in V1. */
export function allowDefaultAutomaticScope(candidate: MemoryCandidate, observation: MemoryObservation): boolean {
  if (candidate.scope === "project") return Boolean(candidate.projectId ?? observation.projectId);
  return candidate.scope === "user";
}

function projectIdFor(candidate: MemoryCandidate): string | undefined {
  return candidate.scope === "project" || candidate.scope === "local" || candidate.scope === "team"
    ? candidate.projectId
    : undefined;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}
