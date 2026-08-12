import { formationCellToObservation, type FormationCell } from "./formation-cell.js";
import {
  MemoryFormationPipeline,
  type CandidateExtractor,
  type FormationResult,
  type MemoryCandidate,
  type MemoryFormationOptions,
  type MemoryObservation,
} from "./memory-formation.js";
import type { MemoryRecord } from "../records/memory-record.js";

/** Durable parent episode plus original evidence used to derive child memories. */
export interface DerivedMemoryExtractionInput {
  /** Original closed cell observation used to preserve transcript provenance. */
  readonly observation: MemoryObservation;
  /** Episode record already written from the same cell. */
  readonly episode: MemoryRecord;
}

/** Extracts factual, procedural, and semantic children from a written episode. */
export interface DerivedCandidateExtractor {
  extract(
    input: DerivedMemoryExtractionInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly MemoryCandidate[]>;
}

/** Episode-first extractors plus shared policy and persistence gates. */
export interface CellMemoryFormationOptions extends Omit<MemoryFormationOptions, "extractor"> {
  /** Extracts the first-layer episodic record from a closed FormationCell. */
  readonly episodeExtractor: CandidateExtractor;
  /** Extracts factual/procedural/semantic records derived from the written episode. */
  readonly derivedExtractor: DerivedCandidateExtractor;
}

/** Episode-stage outcomes and the first written parent used for derivation. */
export interface EpisodeFormationStageResult {
  readonly results: readonly FormationResult[];
  readonly episode?: MemoryRecord;
}

/** Writes episode-first long-term memory and then derives child memories from the episode. */
export class CellMemoryFormationPipeline {
  /** @param options Shared gates plus episode-first staged extractors. */
  public constructor(private readonly options: CellMemoryFormationOptions) {}

  /** Executes only the parent Episode stage so a durable worker can checkpoint before derivation. */
  public async formEpisode(
    cell: FormationCell,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<EpisodeFormationStageResult> {
    const observation = formationCellToObservation(cell);
    // Stage 1 writes an episodic parent first. A closed Cell becomes a durable
    // "what happened" narrative before atomic facts, rules, or semantic
    // relations are derived from the same evidence.
    const episodeResults = await new MemoryFormationPipeline({
      ...this.options,
      extractor: new EpisodeOnlyExtractor(this.options.episodeExtractor),
    }).form(observation, options);
    const writtenEpisodes = episodeResults
      .flatMap((result) => result.status === "written" && result.record.memoryClass === "episodic" ? [result.record] : []);
    return {
      results: episodeResults,
      ...(writtenEpisodes[0] ? { episode: writtenEpisodes[0] } : {}),
    };
  }

  /** Executes only derived child formation from an already durable parent Episode. */
  public async extractDerived(
    cell: FormationCell,
    episode: MemoryRecord,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly MemoryCandidate[]> {
    const observation = formationCellToObservation(cell);
    return (await this.options.derivedExtractor.extract({ observation, episode }, options))
      .filter((candidate) => candidate.memoryClass !== "episodic")
      .map((candidate) => ({
        ...candidate,
        // Candidate identity is frozen before any child write. Persisting this
        // array lets crash recovery resume without another non-deterministic LLM call.
        parentMemoryIds: [...new Set([...(candidate.parentMemoryIds ?? []), episode.id])],
      }));
  }

  /** Runs one persisted child candidate through all local policy and write gates. */
  public formDerivedCandidate(
    cell: FormationCell,
    candidate: MemoryCandidate,
  ): Promise<readonly FormationResult[]> {
    return new MemoryFormationPipeline({
      ...this.options,
      extractor: { extract: async () => [candidate] },
    }).formCandidates(formationCellToObservation(cell), [candidate]);
  }

  /** Convenience stage retained for direct/offline callers. */
  public async formDerived(
    cell: FormationCell,
    episode: MemoryRecord,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly FormationResult[]> {
    const results: FormationResult[] = [];
    for (const candidate of await this.extractDerived(cell, episode, options)) {
      results.push(...await this.formDerivedCandidate(cell, candidate));
    }
    return results;
  }

  /** Convenience one-shot path retained for tests and offline ingestion. */
  public async formCell(cell: FormationCell): Promise<readonly FormationResult[]> {
    const episodeStage = await this.formEpisode(cell);
    if (!episodeStage.episode) return episodeStage.results;
    return [...episodeStage.results, ...await this.formDerived(cell, episodeStage.episode)];
  }
}

/** Keeps provider over-emission from creating derived records before a parent episode exists. */
class EpisodeOnlyExtractor implements CandidateExtractor {
  public constructor(private readonly inner: CandidateExtractor) {}

  public async extract(
    observation: MemoryObservation,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly MemoryCandidate[]> {
    // Providers may over-emit typed candidates. Until an episode parent exists,
    // accepting derived facts would make provenance weaker, so only episode
    // candidates are allowed in the first stage.
    return (await this.inner.extract(observation, options))
      .filter((candidate) => candidate.memoryClass === undefined || candidate.memoryClass === "episodic")
      .map((candidate) => ({ ...candidate, memoryClass: "episodic" as const }));
  }
}
