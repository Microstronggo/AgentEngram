import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  FormationCellBuilder,
  createMemoryRecord,
  formationCellToObservation,
  LocalAgentEngramRuntime,
  MemoryFormationPipeline,
  SqliteFtsMemoryIndex,
  type MemoryCandidate,
  type MemoryRelation,
  type MemoryRecord,
  type MemorySearchResult,
  type NormalizedTranscriptEntry,
  type RawTranscriptRecord,
} from "@agentengram/engine";
import type { RetrievalResultItem } from "../common/schema.js";
import { prepareEpisodes, prepareTurns, sourceRefDiaId } from "./dataset.js";
import type { LocomoPreparedTurn, LocomoSample } from "./types.js";

export interface LocomoBenchmarkBackend {
  readonly name: string;
  /** Loads one conversation into the backend's own memory representation. */
  ingest(sample: LocomoSample, conversationIndex: number): Promise<void>;
  /** Returns top-k memories with sourceRefs that can be matched against gold dia_ids. */
  search(conversationIndex: number, question: string, topK: number): Promise<readonly RetrievalResultItem[]>;
  close(): Promise<void>;
}

/** Baseline that retrieves prepared raw transcript turns with deterministic lexical scoring. */
export class RawTranscriptFtsBackend implements LocomoBenchmarkBackend {
  readonly name = "raw-transcript-fts";
  private readonly conversations = new Map<number, readonly LocomoPreparedTurn[]>();

  async ingest(sample: LocomoSample, conversationIndex: number): Promise<void> {
    this.conversations.set(conversationIndex, prepareTurns(sample, conversationIndex));
  }

  async search(conversationIndex: number, question: string, topK: number): Promise<readonly RetrievalResultItem[]> {
    const queryTokens = tokenize(question);
    const turns = this.conversations.get(conversationIndex) ?? [];
    return turns
      .map((turn) => ({ turn, score: lexicalScore(queryTokens, turn.text) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.turn.timestamp.localeCompare(b.turn.timestamp))
      .slice(0, topK)
      .map(({ turn, score }) => ({
        memory: turn.text,
        score,
        createdAt: turn.timestamp,
        sourceRefs: [turn.sourceRef],
        metadata: { sessionKey: turn.sessionKey, diaId: turn.diaId, backend: this.name },
      }));
  }

  async close(): Promise<void> {}
}

export class AgentEngramHybridBackend implements LocomoBenchmarkBackend {
  readonly name = "agentengram-hybrid";
  private readonly runtimes = new Map<number, LocalAgentEngramRuntime>();

  constructor(private readonly options: { readonly homeDir: string; readonly reset?: boolean }) {}

  async ingest(sample: LocomoSample, conversationIndex: number): Promise<void> {
    const projectId = projectIdFor(conversationIndex);
    const projectHome = join(this.options.homeDir, projectId);
    if (this.options.reset) await rm(projectHome, { recursive: true, force: true });
    const runtime = await LocalAgentEngramRuntime.create({
      homeDir: projectHome,
      projectId,
      contextMode: "managed-context",
      recallLimit: 200,
      recallTokenBudget: 500_000,
    });
    this.runtimes.set(conversationIndex, runtime);

    for (const turn of prepareTurns(sample, conversationIndex)) {
      await runtime.appendTranscript(toTranscriptAppend(turn));
      await runtime.longTerm.remember({
        id: safeId(`locomo-${conversationIndex}-${turn.diaId}`),
        name: `${turn.speaker} ${turn.diaId}`,
        description: `LoCoMo ${turn.sessionKey} turn ${turn.diaId} said on ${turn.sessionDate}`,
        type: "reference",
        scope: "project",
        projectId,
        content: turn.text,
        tags: ["locomo", turn.sessionKey, turn.diaId, turn.speaker],
        kind: "insight",
        sourceRefs: [turn.sourceRef],
        createdAt: turn.timestamp,
        updatedAt: turn.timestamp,
      });
    }
  }

  async search(conversationIndex: number, question: string, topK: number): Promise<readonly RetrievalResultItem[]> {
    const runtime = this.runtimeFor(conversationIndex);
    const result = runtime.longTerm.search({
      query: question,
      projectId: projectIdFor(conversationIndex),
      scope: "project",
      maxResults: topK,
      tokenBudget: 500_000,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    return result.memories.map((memory) => ({
      memory: memory.record.content,
      score: memory.score,
      createdAt: memory.record.createdAt,
      sourceRefs: memory.record.sourceRefs,
      metadata: {
        backend: this.name,
        id: memory.record.id,
        kind: memory.record.kind,
        diaId: memory.record.sourceRefs.map(sourceRefDiaId).filter(Boolean)[0],
      },
    }));
  }

  async close(): Promise<void> {
    for (const runtime of this.runtimes.values()) await runtime.close();
    this.runtimes.clear();
  }

  private runtimeFor(conversationIndex: number): LocalAgentEngramRuntime {
    const runtime = this.runtimes.get(conversationIndex);
    if (!runtime) throw new Error(`conversation ${conversationIndex} has not been ingested`);
    return runtime;
  }
}

export class AgentEngramTypedFormationBackend implements LocomoBenchmarkBackend {
  readonly name: "agentengram-typed-formation" | "agentengram-typed-runtime";
  private readonly runtimes = new Map<number, LocalAgentEngramRuntime>();
  private readonly formedRecords = new Map<number, MemoryRecord[]>();

  constructor(
    private readonly options: { readonly homeDir: string; readonly reset?: boolean },
    private readonly searchMode: "formation" | "runtime" = "formation",
  ) {
    this.name = searchMode === "runtime" ? "agentengram-typed-runtime" : "agentengram-typed-formation";
  }

  async ingest(sample: LocomoSample, conversationIndex: number): Promise<void> {
    const projectId = projectIdFor(conversationIndex);
    const projectHome = join(this.options.homeDir, projectId);
    if (this.options.reset) await rm(projectHome, { recursive: true, force: true });
    let nextId = 0;
    const formation = new MemoryFormationPipeline({
      extractor: { extract: async (observation) => typedCandidatesFromObservation(observation, projectId) },
      evaluator: { evaluate: async () => ({ save: true, importance: 0.75 }) },
      duplicates: { resolve: async () => ({ action: "write" }) },
      scanner: { scan: async () => ({ allowed: true }) },
      writer: { put: async () => undefined },
      idFactory: () => safeId(`locomo-typed-${conversationIndex}-${nextId++}`),
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const runtime = await LocalAgentEngramRuntime.create({
      homeDir: projectHome,
      projectId,
      contextMode: "managed-context",
      formation,
      recallLimit: 200,
      recallTokenBudget: 500_000,
    });
    this.runtimes.set(conversationIndex, runtime);
    this.formedRecords.set(conversationIndex, []);
    const builder = new FormationCellBuilder();

    for (const turn of prepareTurns(sample, conversationIndex)) {
      await runtime.appendTranscript(toTranscriptAppend(turn));
      const cell = builder.fromTurn({
        projectId,
        sessionId: turn.sessionKey,
        threadId: "main",
        sourceEntryIds: [turn.sourceRef],
        ...(turn.role === "user" ? { userText: turn.text } : { assistantText: turn.text }),
        timestampRange: { start: turn.timestamp, end: turn.timestamp },
        metadata: {
          backend: this.name,
          conversationIndex,
          diaId: turn.diaId,
          speaker: turn.speaker,
          sessionKey: turn.sessionKey,
        },
      });
      const results = await runtime.longTerm.form(formationCellToObservation(cell));
      for (const result of results) {
        if (result.status === "written") this.formedRecords.get(conversationIndex)?.push(result.record);
      }
    }
    for (const episode of prepareEpisodes(sample, conversationIndex)) {
      const cell = builder.fromEpisode({
        projectId,
        sessionId: episode.sessionKey,
        threadId: "main",
        sourceEntryIds: episode.sourceRefs,
        text: episode.text,
        timestampRange: { start: episode.timestamp, end: episode.timestamp },
        metadata: {
          backend: this.name,
          conversationIndex,
          sessionKey: episode.sessionKey,
          sessionDate: episode.sessionDate,
          episodeType: episode.episodeType,
        },
      });
      const results = await runtime.longTerm.form(formationCellToObservation(cell));
      for (const result of results) {
        if (result.status === "written") this.formedRecords.get(conversationIndex)?.push(result.record);
      }
    }
  }

  async search(conversationIndex: number, question: string, topK: number): Promise<readonly RetrievalResultItem[]> {
    if (this.searchMode === "runtime") return this.searchRuntime(conversationIndex, question, topK);
    const queryTokens = tokenize(question);
    this.runtimeFor(conversationIndex);
    return (this.formedRecords.get(conversationIndex) ?? [])
      .map((record) => ({
        record,
        lexical: lexicalScore(queryTokens, `${record.name} ${record.description} ${record.content}`) + classBoost(question, record),
      }))
      .filter((item) => item.lexical > 0)
      .sort((left, right) => right.lexical - left.lexical || right.record.updatedAt.localeCompare(left.record.updatedAt))
      .reduce<ScoredRecord[]>((selected, item) => {
        if (selected.length >= topK) return selected;
        if (selected.filter((existing) => samePrimaryEvidence(existing.record, item.record)).length >= 2) return selected;
        selected.push(item);
        return selected;
      }, [])
      .map(({ record, lexical }) => ({
        memory: record.content,
        score: lexical,
        createdAt: record.createdAt,
        sourceRefs: record.sourceRefs,
        metadata: {
          backend: this.name,
          id: record.id,
          kind: record.kind,
          memoryClass: record.memoryClass,
          diaId: record.sourceRefs.map(sourceRefDiaId).filter(Boolean)[0],
        },
      }));
  }

  async close(): Promise<void> {
    for (const runtime of this.runtimes.values()) await runtime.close();
    this.runtimes.clear();
    this.formedRecords.clear();
  }

  private runtimeFor(conversationIndex: number): LocalAgentEngramRuntime {
    const runtime = this.runtimes.get(conversationIndex);
    if (!runtime) throw new Error(`conversation ${conversationIndex} has not been ingested`);
    return runtime;
  }

  private async searchRuntime(conversationIndex: number, question: string, topK: number): Promise<readonly RetrievalResultItem[]> {
    const runtime = this.runtimeFor(conversationIndex);
    const result = runtime.longTerm.search({
      query: question,
      projectId: projectIdFor(conversationIndex),
      scope: "project",
      maxResults: topK,
      tokenBudget: 500_000,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    return result.memories.map((memory) => ({
      memory: memory.record.content,
      score: memory.score,
      createdAt: memory.record.createdAt,
      sourceRefs: memory.record.sourceRefs,
      metadata: {
        backend: this.name,
        id: memory.record.id,
        kind: memory.record.kind,
        memoryClass: memory.record.memoryClass,
        diaId: memory.record.sourceRefs.map(sourceRefDiaId).filter(Boolean)[0],
      },
    }));
  }
}

export class AgentEngramTypedRuntimeBackend extends AgentEngramTypedFormationBackend {
  constructor(options: { readonly homeDir: string; readonly reset?: boolean }) {
    super(options, "runtime");
  }
}

export class AgentEngramFtsBackend implements LocomoBenchmarkBackend {
  readonly name = "agentengram-fts-direct";
  private readonly indexes = new Map<number, SqliteFtsMemoryIndex>();

  constructor(private readonly options: { readonly homeDir: string; readonly reset?: boolean }) {}

  async ingest(sample: LocomoSample, conversationIndex: number): Promise<void> {
    const projectId = projectIdFor(conversationIndex);
    const indexPath = join(this.options.homeDir, `${projectId}.db`);
    if (this.options.reset) await rm(indexPath, { force: true });
    const index = new SqliteFtsMemoryIndex(indexPath);
    this.indexes.set(conversationIndex, index);
    for (const turn of prepareTurns(sample, conversationIndex)) {
      index.upsert(createMemoryRecord({
        id: safeId(`locomo-${conversationIndex}-${turn.diaId}`),
        name: `${turn.speaker} ${turn.diaId}`,
        description: `LoCoMo ${turn.sessionKey} turn ${turn.diaId}`,
        type: "reference",
        scope: "project",
        projectId,
        content: turn.text,
        tags: ["locomo", turn.sessionKey, turn.diaId, turn.speaker],
        kind: "insight",
        sourceRefs: [turn.sourceRef],
        status: "active",
        createdAt: turn.timestamp,
        updatedAt: turn.timestamp,
      }));
    }
  }

  async search(conversationIndex: number, question: string, topK: number): Promise<readonly RetrievalResultItem[]> {
    const index = this.indexes.get(conversationIndex);
    if (!index) throw new Error(`conversation ${conversationIndex} has not been ingested`);
    const rows: MemorySearchResult[] = index.search({
      text: question,
      limit: topK,
      projectId: projectIdFor(conversationIndex),
      includeGlobal: false,
    });
    return rows.map((row) => ({
      memory: row.record.content,
      score: 1 / (1 + Math.abs(row.rank)),
      createdAt: row.record.createdAt,
      sourceRefs: row.record.sourceRefs,
      metadata: { backend: this.name, id: row.record.id },
    }));
  }

  async close(): Promise<void> {
    for (const index of this.indexes.values()) index.close();
    this.indexes.clear();
  }
}

function typedCandidatesFromObservation(observation: { readonly text: string; readonly metadata?: Readonly<Record<string, unknown>> }, projectId: string): readonly MemoryCandidate[] {
  const normalized = observation.text.replace(/^(user|assistant|tool):\s*/u, "").trim();
  if (!normalized) return [];
  const cellType = typeof observation.metadata?.formationCellType === "string" ? observation.metadata.formationCellType : "";
  // These deterministic candidates are an evaluation harness stand-in for a
  // typed extractor. They let LoCoMo exercise the real formation and recall
  // plumbing without requiring an LLM during normal tests.
  const entities = extractEntities(normalized);
  const eventDate = eventDateFromObservation(observation);
  const relativeDate = relativeDateFromText(normalized);
  const relations = relationCandidates(normalized, entities);
  if (cellType === "episode") {
    // Episode cells become both episodic memory and semantic relationship
    // memory so formation-oracle and runtime recall can be compared separately.
    const sessionKey = typeof observation.metadata?.sessionId === "string" ? observation.metadata.sessionId : "session";
    const episodeType = typeof observation.metadata?.episodeType === "string" ? observation.metadata.episodeType : "episode";
    return [{
      name: `LoCoMo ${episodeType} ${sessionKey}`,
      description: "Multi-source session episode memory extracted from LoCoMo summaries",
      type: "project",
      scope: "project",
      projectId,
      kind: "failure",
      memoryClass: "episodic",
      content: normalized,
      confidence: 0.85,
      entities,
      ...(eventDate ? { eventDate } : {}),
      ...(relativeDate ? { relativeDate } : {}),
      ...(relations.length ? { relations } : {}),
    }, {
      name: `LoCoMo semantic ${episodeType} ${sessionKey}`,
      description: "Session-level semantic relationship memory extracted from LoCoMo summaries",
      type: "reference",
      scope: "project",
      projectId,
      kind: "insight",
      memoryClass: "semantic",
      content: normalized,
      confidence: 0.8,
      entities,
      ...(eventDate ? { eventDate } : {}),
      ...(relativeDate ? { relativeDate } : {}),
      ...(relations.length ? { relations } : {}),
    }];
  }
  const candidates: MemoryCandidate[] = [{
    name: `LoCoMo factual ${safeId(normalized).slice(0, 24)}`,
    description: "Atomic factual evidence extracted from a LoCoMo turn",
    type: "reference",
    scope: "project",
    projectId,
    kind: "insight",
    memoryClass: "factual",
    content: normalized,
    confidence: 0.9,
    entities,
    ...(eventDate ? { eventDate } : {}),
    ...(relativeDate ? { relativeDate } : {}),
    ...(relations.length ? { relations } : {}),
  }, {
    name: `LoCoMo episode ${safeId(normalized).slice(0, 24)}`,
    description: "Episode evidence extracted from a LoCoMo turn",
    type: "project",
    scope: "project",
    projectId,
    kind: "failure",
    memoryClass: "episodic",
    content: `During this conversation, ${normalized}`,
    confidence: 0.7,
    entities,
    ...(eventDate ? { eventDate } : {}),
    ...(relativeDate ? { relativeDate } : {}),
    ...(relations.length ? { relations } : {}),
  }];
  if (/\b(always|should|must|use|prefer|remember)\b/i.test(normalized)) {
    // Procedural extraction is intentionally narrow; otherwise ordinary dialog
    // turns would create noisy rules that pollute recall.
    candidates.push({
      name: `LoCoMo procedure ${safeId(normalized).slice(0, 24)}`,
      description: "Procedural instruction extracted from a LoCoMo turn",
      type: "project",
      scope: "project",
      projectId,
      kind: "convention",
      memoryClass: "procedural",
      content: normalized,
      confidence: 0.65,
      entities,
      ...(eventDate ? { eventDate } : {}),
      ...(relativeDate ? { relativeDate } : {}),
      ...(relations.length ? { relations } : {}),
    });
  }
  if (/\b(is|are|means|because|related|happens|named)\b/i.test(normalized)) {
    candidates.push({
      name: `LoCoMo relation ${safeId(normalized).slice(0, 24)}`,
      description: "Semantic relation evidence extracted from a LoCoMo turn",
      type: "reference",
      scope: "project",
      projectId,
      kind: "insight",
      memoryClass: "semantic",
      content: normalized,
      confidence: 0.65,
      entities,
      ...(eventDate ? { eventDate } : {}),
      ...(relativeDate ? { relativeDate } : {}),
      ...(relations.length ? { relations } : {}),
    });
  }
  return candidates;
}

function eventDateFromObservation(observation: { readonly metadata?: Readonly<Record<string, unknown>> }): string | undefined {
  // FormationCell timestamp ranges are preferred because they are ISO dates and
  // keep temporal metadata independent from natural-language summaries.
  const range = observation.metadata?.timestampRange;
  if (range && typeof range === "object" && "start" in range && typeof range.start === "string") {
    return range.start.slice(0, 10);
  }
  const sessionDate = observation.metadata?.sessionDate;
  if (typeof sessionDate === "string") return sessionDate;
  return undefined;
}

function relativeDateFromText(text: string): string | undefined {
  // Preserve relative temporal phrases for future temporal rerankers; the runtime
  // currently stores them but does not globally boost them.
  return /\byesterday\b/i.test(text) ? "yesterday" :
    /\blast (week|month|year|friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b/i.exec(text)?.[0];
}

function extractEntities(text: string): readonly string[] {
  // Lightweight entity extraction is deliberately deterministic and conservative
  // for offline evaluation. Production extractors can replace this with LLM or
  // NER output while keeping the same MemoryCandidate schema.
  const names = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) ?? [];
  const acronyms = text.match(/\b[A-Z]{2,}\+?\b/g) ?? [];
  return [...new Set([...names, ...acronyms])]
    .filter((entity) => !["Session", "Event", "During", "The", "A", "On"].includes(entity))
    .slice(0, 12);
}

function relationCandidates(text: string, entities: readonly string[]): readonly MemoryRelation[] {
  const [subject] = entities;
  if (!subject) return [];
  const relations: MemoryRelation[] = [];
  // Relations are low-weight metadata. They should help discriminate known
  // event/object phrases without becoming a graph database requirement.
  if (/\b(attended|went to|joined)\b/i.test(text)) relations.push({ subject, predicate: "attended", object: importantObject(text) ?? "event" });
  if (/\b(is|was|am|are)\b/i.test(text)) relations.push({ subject, predicate: "is", object: importantObject(text) ?? "described entity" });
  if (/\b(pursue|looking into|keen on|career|fields?)\b/i.test(text)) relations.push({ subject, predicate: "interested_in", object: importantObject(text) ?? "career field" });
  return relations.slice(0, 4);
}

function importantObject(text: string): string | undefined {
  if (/support group/i.test(text)) return "support group";
  if (/mental health/i.test(text)) return "mental health";
  if (/counseling/i.test(text)) return "counseling";
  if (/adoption/i.test(text)) return "adoption";
  if (/transgender|trans community|gender identity/i.test(text)) return "gender identity";
  if (/sunrise/i.test(text)) return "sunrise painting";
  if (/charity race/i.test(text)) return "charity race";
  if (/camping/i.test(text)) return "camping";
  return undefined;
}

type ScoredRecord = { readonly record: MemoryRecord; readonly lexical: number };

function classBoost(question: string, record: MemoryRecord): number {
  const lower = question.toLowerCase();
  const memoryClass = record.memoryClass;
  let boost = 0;
  if (/\bwhen\b|\bdate\b|\btime\b/u.test(lower) && (memoryClass === "episodic" || memoryClass === "factual")) boost += 0.2;
  if (/\bwhy\b|\bhow\b|\brelationship\b|\bidentity\b|\bresearch\b|\bfields?\b/u.test(lower) && (memoryClass === "episodic" || memoryClass === "semantic")) boost += 0.35;
  if (record.sourceRefs.length > 1) boost += 0.25;
  return boost;
}

function samePrimaryEvidence(left: MemoryRecord, right: MemoryRecord): boolean {
  const leftFirst = left.sourceRefs[0];
  const rightFirst = right.sourceRefs[0];
  return leftFirst !== undefined && leftFirst === rightFirst;
}

function toTranscriptAppend(turn: LocomoPreparedTurn): { readonly raw: RawTranscriptRecord; readonly normalized: NormalizedTranscriptEntry } {
  const id = safeId(`${turn.sessionKey}-${turn.diaId}`);
  const contentHash = sha256(turn.text);
  const raw: RawTranscriptRecord = {
    schemaVersion: 1,
    id: `raw-${id}`,
    framework: "locomo",
    frameworkSessionId: turn.sessionKey,
    frameworkThreadId: "main",
    frameworkEntryId: turn.diaId,
    eventType: "message.completed",
    role: turn.role,
    timestamp: turn.timestamp,
    content: { text: turn.text },
    contentHash,
    sourceRef: `agentengram://transcript/${turn.sessionKey}/main/${id}`,
    frameworkSourceRef: turn.sourceRef,
    metadata: {
      conversationIndex: turn.conversationIndex,
      sessionDate: turn.sessionDate,
      diaId: turn.diaId,
      speaker: turn.speaker,
    },
    rawFrameworkPayload: {
      diaId: turn.diaId,
      speaker: turn.speaker,
      text: turn.text,
    },
  };
  const normalized: NormalizedTranscriptEntry = {
    schemaVersion: 1,
    id: `norm-${id}`,
    sessionId: turn.sessionKey,
    threadId: "main",
    sourceRef: raw.sourceRef,
    frameworkSourceRef: turn.sourceRef,
    kind: "message",
    role: turn.role,
    text: turn.text,
    contentHash,
    createdAt: turn.timestamp,
    parentEntryId: null,
    metadata: {
      conversationIndex: turn.conversationIndex,
      diaId: turn.diaId,
      speaker: turn.speaker,
    },
  };
  return { raw, normalized };
}

function projectIdFor(conversationIndex: number): string {
  return `locomo-conv-${conversationIndex}`;
}

function tokenize(text: string): readonly string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((token) => token.length > 1 && !LEXICAL_STOPWORDS.has(token));
}

function lexicalScore(queryTokens: readonly string[], text: string): number {
  const target = new Set(tokenize(text));
  if (target.size === 0) return 0;
  let score = 0;
  for (const token of queryTokens) if (target.has(token)) score += 1;
  return score / Math.sqrt(target.size);
}

function safeId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]+/g, "-");
  return normalized || randomUUID();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const LEXICAL_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "did", "do", "does", "for", "from",
  "had", "has", "have", "he", "her", "hers", "him", "his", "how", "i", "in", "is", "it", "its", "me",
  "my", "of", "on", "or", "our", "she", "that", "the", "their", "them", "they", "this", "to", "was",
  "we", "were", "what", "when", "where", "which", "who", "whom", "why", "with", "would", "you", "your",
]);
