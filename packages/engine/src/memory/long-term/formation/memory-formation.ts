import {
  createMemoryRecord,
  type MemoryClass,
  type MemoryKind,
  type MemoryRelation,
  type MemoryRecord,
  type MemoryScope,
  type MemoryType,
} from "../records/memory-record.js";

/** Evidence window presented to extraction while retaining canonical provenance. */
export interface MemoryObservation {
  readonly text: string;
  readonly sourceRefs: readonly string[];
  readonly projectId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Non-durable typed memory proposal emitted before policy and safety gates. */
export interface MemoryCandidate {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
  readonly scope: MemoryScope;
  readonly content: string;
  readonly kind?: MemoryKind;
  readonly memoryClass?: MemoryClass;
  readonly confidence?: number;
  readonly projectId?: string;
  readonly entities?: readonly string[];
  readonly eventDate?: string;
  readonly relativeDate?: string;
  readonly relations?: readonly MemoryRelation[];
  /** Durable parent memories that this candidate was derived from. */
  readonly parentMemoryIds?: readonly string[];
}

/** Converts one evidence window into zero or more typed proposals. */
export interface CandidateExtractor {
  extract(observation: MemoryObservation, options?: { readonly signal?: AbortSignal }): Promise<readonly MemoryCandidate[]>;
}

/** Decides whether a candidate is valuable enough to persist. */
export interface SignificanceEvaluator {
  evaluate(
    candidate: MemoryCandidate,
    observation: MemoryObservation,
  ): Promise<{ readonly save: boolean; readonly importance: number; readonly reason?: string }>;
}

/** Resolves a candidate against active Markdown truth before writing. */
export interface DuplicateResolver {
  resolve(
    candidate: MemoryCandidate,
  ): Promise<
    | { readonly action: "write" }
    | { readonly action: "skip"; readonly existingId: string }
    | { readonly action: "supersede"; readonly existingId: string; readonly existingRecord?: MemoryRecord }
  >;
}

/** Rejects secrets, prompt injection, or otherwise unsafe durable content. */
export interface MemoryContentScanner {
  scan(candidate: MemoryCandidate): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }>;
}

/** Durable write boundary implemented by Markdown truth plus rebuildable projections. */
export interface MemoryWriter {
  put(record: MemoryRecord): Promise<void>;
}

/** Ordered extraction, policy, safety, dedupe, and persistence dependencies. */
export interface MemoryFormationOptions {
  readonly extractor: CandidateExtractor;
  readonly evaluator: SignificanceEvaluator;
  readonly duplicates: DuplicateResolver;
  readonly scanner: MemoryContentScanner;
  readonly writer: MemoryWriter;
  /** Stable record id factory; receives candidate and evidence for idempotent retries. */
  readonly idFactory?: (candidate: MemoryCandidate, observation: MemoryObservation) => string;
  readonly clock?: () => Date;
  /** Scope promotion is denied unless the host explicitly authorizes it. */
  readonly allowScope?: (candidate: MemoryCandidate, observation: MemoryObservation) => boolean;
}

/** Per-candidate outcome retained for tests, diagnostics, and retry policy. */
export type FormationResult =
  | { readonly status: "written"; readonly record: MemoryRecord; readonly supersededRecord?: MemoryRecord }
  | { readonly status: "skipped"; readonly reason: "not-significant" | "duplicate" | "unsafe" | "scope-denied"; readonly detail?: string };

/** Framework-neutral orchestration for immediate and background memory formation. */
export class MemoryFormationPipeline {
  /** @param options Ordered extraction, significance, safety, dedupe, and write stages. */
  public constructor(private readonly options: MemoryFormationOptions) {}

  public async form(
    observation: MemoryObservation,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly FormationResult[]> {
    // Extraction is intentionally separate from policy gates so staged Cell
    // formation can reuse formCandidates() after writing the parent episode.
    const candidates = await this.options.extractor.extract(observation, options);
    return this.formCandidates(observation, candidates);
  }

  /** Writes pre-extracted candidates through the same policy, safety, dedupe, and writer stages. */
  public async formCandidates(
    observation: MemoryObservation,
    candidates: readonly MemoryCandidate[],
  ): Promise<readonly FormationResult[]> {
    const results: FormationResult[] = [];

    // Scope authorization precedes model judgment and all durable side effects.
    for (const candidate of candidates) {
      if (this.options.allowScope && !this.options.allowScope(candidate, observation)) {
        results.push({ status: "skipped", reason: "scope-denied", detail: candidate.scope });
        continue;
      }
      const significance = await this.options.evaluator.evaluate(candidate, observation);
      if (!significance.save) {
        results.push({ status: "skipped", reason: "not-significant", ...(significance.reason ? { detail: significance.reason } : {}) });
        continue;
      }

      const safety = await this.options.scanner.scan(candidate);
      if (!safety.allowed) {
        results.push({ status: "skipped", reason: "unsafe", detail: safety.reason });
        continue;
      }

      const duplicate = await this.options.duplicates.resolve(candidate);
      if (duplicate.action === "skip") {
        results.push({ status: "skipped", reason: "duplicate", detail: duplicate.existingId });
        continue;
      }

      const record = createMemoryRecord(
        {
          id: this.options.idFactory?.(candidate, observation) ?? crypto.randomUUID(),
          name: candidate.name,
          description: candidate.description,
          type: candidate.type,
          scope: candidate.scope,
          content: candidate.content,
          sourceRefs: [...observation.sourceRefs],
          importance: significance.importance,
          ...(candidate.kind ? { kind: candidate.kind } : {}),
          ...(candidate.memoryClass ? { memoryClass: candidate.memoryClass } : {}),
          ...(candidate.entities ? { entities: candidate.entities } : {}),
          ...(candidate.eventDate ? { eventDate: candidate.eventDate } : {}),
          ...(candidate.relativeDate ? { relativeDate: candidate.relativeDate } : {}),
          ...(candidate.relations ? { relations: candidate.relations } : {}),
          ...(candidate.parentMemoryIds ? { parentMemoryIds: candidate.parentMemoryIds } : {}),
          ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
          ...(candidate.projectId ?? observation.projectId
            ? { projectId: candidate.projectId ?? observation.projectId }
            : {}),
          ...(duplicate.action === "supersede" ? { supersedes: duplicate.existingId } : {}),
        },
        this.options.clock?.() ?? new Date(),
      );
      let supersededRecord: MemoryRecord | undefined;
      if (duplicate.action === "supersede" && duplicate.existingRecord) {
        // Supersede is implemented as an append-friendly lifecycle transition:
        // the old record remains durable for temporal questions, while the new
        // record carries the forward pointer through `supersedes`.
        supersededRecord = {
          ...duplicate.existingRecord,
          status: "superseded",
          updatedAt: this.options.clock?.().toISOString() ?? new Date().toISOString(),
        };
        await this.options.writer.put(supersededRecord);
      }
      await this.options.writer.put(record);
      results.push({ status: "written", record, ...(supersededRecord ? { supersededRecord } : {}) });
    }

    return results;
  }
}
