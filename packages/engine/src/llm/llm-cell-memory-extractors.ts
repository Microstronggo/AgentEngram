import type {
  CandidateExtractor,
  MemoryCandidate,
  MemoryObservation,
} from "../memory/long-term/formation/memory-formation.js";
import type { DerivedCandidateExtractor } from "../memory/long-term/formation/cell-memory-formation.js";
import {
  LLMMemoryCandidateExtractor,
  type LLMMemoryCandidateExtractorOptions,
} from "./llm-memory-candidate-extractor.js";

/** Options for the first-stage episodic extractor. */
export type LLMEpisodeCandidateExtractorOptions = LLMMemoryCandidateExtractorOptions;
/** Options for factual, procedural, and semantic derivation from an episode. */
export type LLMDerivedMemoryExtractorOptions = LLMMemoryCandidateExtractorOptions;

const EPISODE_SYSTEM_PROMPT = [
  "You are AgentEngram's episodic memory extractor.",
  "Input is one closed memory Cell, not an entire transcript.",
  "Return JSON only as {\"candidates\": [...]} with zero or one candidate.",
  "Every candidate must contain non-empty name, description, content, type, scope, memoryClass, and may contain kind, confidence, projectId, entities, eventDate, relativeDate, relations.",
  "Allowed type values: user, feedback, project, reference. Allowed scope values: user, project, local, agent, team.",
  "Allowed kind values: preference, correction, decision, convention, failure, insight, tool-quirk.",
  "Only write an episodic memory when the Cell contains a durable event, task, decision, validation, failure, or outcome.",
  "The candidate must use memoryClass=episodic, type=project, scope=project unless the source clearly requires a different supported value.",
  "Write a third-person narrative that preserves participants, timing, task/result, and evidence-bearing tool outcomes.",
  "Do not extract atomic facts, future rules, or concept relations in this stage.",
].join("\n");

const DERIVED_SYSTEM_PROMPT = [
  "You are AgentEngram's derived long-term memory extractor.",
  "Input contains a written parent episode plus the original source Cell.",
  "Return JSON only as {\"candidates\": [...]}.",
  "Every candidate must contain non-empty name, description, content, type, scope, memoryClass, and may contain kind, confidence, projectId, entities, eventDate, relativeDate, relations.",
  "Allowed type values: user, feedback, project, reference. Allowed scope values: user, project, local, agent, team.",
  "Allowed kind values: preference, correction, decision, convention, failure, insight, tool-quirk.",
  "Allowed memoryClass values in this stage: factual, procedural, semantic. Do not emit episodic candidates.",
  "Factual candidates must be one atomic fact each, with clear ownership and no unsupported inference.",
  "Procedural candidates must be explicit future rules, corrections, workflows, or tool habits that affect later agent behavior.",
  "Semantic candidates must describe concept boundaries, dependencies, substitutions, causality, or relations; include relation triples when possible.",
  "Do not copy generic chat, greetings, or temporary implementation details that will not help future sessions.",
].join("\n");

/** LLM-backed closed Cell to episodic candidate extractor. */
export class LLMEpisodeCandidateExtractor implements CandidateExtractor {
  /** Generic schema-normalizing extractor configured for the episode stage. */
  private readonly inner: LLMMemoryCandidateExtractor;

  /** @param options Shared client and optional episode prompt override. */
  public constructor(options: LLMEpisodeCandidateExtractorOptions) {
    this.inner = new LLMMemoryCandidateExtractor({
      ...options,
      systemPrompt: options.systemPrompt ?? EPISODE_SYSTEM_PROMPT,
      defaultMemoryClass: "episodic",
      defaultType: options.defaultType ?? "project",
      defaultScope: options.defaultScope ?? "project",
      defaultKind: options.defaultKind ?? "insight",
    });
  }

  /** Produces at most one episodic parent candidate for a closed Cell. */
  public async extract(
    observation: MemoryObservation,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly MemoryCandidate[]> {
    return (await this.inner.extract(observation, options))
      .filter((candidate) => candidate.memoryClass === undefined || candidate.memoryClass === "episodic")
      .slice(0, 1)
      .map((candidate) => ({ ...candidate, memoryClass: "episodic" as const }));
  }
}

/** LLM-backed episode to factual/procedural/semantic child extractor. */
export class LLMDerivedMemoryExtractor implements DerivedCandidateExtractor {
  /** Generic schema-normalizing extractor configured for child derivation. */
  private readonly inner: LLMMemoryCandidateExtractor;

  /** @param options Shared client and optional derived-memory prompt override. */
  public constructor(options: LLMDerivedMemoryExtractorOptions) {
    this.inner = new LLMMemoryCandidateExtractor({
      ...options,
      systemPrompt: options.systemPrompt ?? DERIVED_SYSTEM_PROMPT,
      defaultType: options.defaultType ?? "project",
      defaultScope: options.defaultScope ?? "project",
    });
  }

  /** Derives child memories from the durable parent narrative and original evidence. */
  public async extract(
    input: Parameters<DerivedCandidateExtractor["extract"]>[0],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly MemoryCandidate[]> {
    // The parent comes first so atomization starts from a stable narrative while
    // the source Cell remains available to recover omitted rules and relations.
    const observation = {
      ...input.observation,
      text: ["# Parent Episode", input.episode.content, "", "# Source Cell", input.observation.text].join("\n"),
      metadata: {
        ...input.observation.metadata,
        parentMemoryId: input.episode.id,
        formationStage: "derived",
      },
    };
    return (await this.inner.extract(observation, options))
      .filter((candidate) => candidate.memoryClass !== "episodic");
  }
}
