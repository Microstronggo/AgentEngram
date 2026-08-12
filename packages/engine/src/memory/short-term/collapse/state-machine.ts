import type { AgentMessage } from "../../../protocol/message.js";
import type { CollapseCandidate, TurnGroup } from "./candidates.js";
import { selectCollapseCandidates } from "./candidates.js";
import { collapseThresholds, type CollapseThresholds } from "./config.js";

/** Transaction phase of one proactive history-collapse span. */
export type CollapseSpanState = "candidate" | "staged" | "committed" | "projected";

/** Stable transcript span selected for replacement by one summary. */
export interface CollapseSpan {
  readonly id: string;
  readonly startEventId: string;
  readonly endEventId: string;
  readonly groupIds: readonly string[];
  readonly originalTokens: number;
  readonly summary: string;
  readonly risk: number;
  readonly state: CollapseSpanState;
  readonly stagedAt: string;
  readonly committedAt?: string;
  readonly commitSequence?: number;
  readonly dependsOnCommitSequence?: number;
  readonly algorithmVersion: string;
  readonly configVersion: string;
}

/** Persistable Collapse controller state used by checkpoint recovery. */
export interface CollapseSnapshot {
  readonly version: 1;
  readonly lastObservedTokens: number;
  readonly lastSpawnTokens: number;
  readonly nextCommitSequence: number;
  readonly staged: readonly CollapseSpan[];
  readonly commits: readonly CollapseSpan[];
}

/** Summarizes one candidate span without owning state transitions. */
export interface CollapseSummarizer {
  summarize(input: {
    readonly candidate: CollapseCandidate;
    readonly groups: readonly TurnGroup[];
    readonly messages: readonly AgentMessage[];
    readonly signal?: AbortSignal;
  }): Promise<{ readonly summary: string }>;
}

/** Thresholds, summarizer, and clock used by the Collapse state machine. */
export interface CollapseControllerOptions {
  readonly effectiveWindowTokens: number;
  readonly summarizer: CollapseSummarizer;
  readonly now?: () => Date;
  readonly idFactory?: (candidate: CollapseCandidate) => string;
  readonly algorithmVersion?: string;
  readonly configVersion?: string;
  readonly snapshot?: CollapseSnapshot;
}

/** Stages summaries ahead of pressure and commits them in deterministic transcript order. */
export class CollapseController {
  /** Token thresholds derived from the effective context window. */
  readonly thresholds: CollapseThresholds;
  /** Model-backed span summarizer. */
  private readonly summarizer: CollapseSummarizer;
  /** Injectable clock for deterministic snapshots and tests. */
  private readonly now: () => Date;
  /** Stable collapse span identifier factory. */
  private readonly idFactory: (candidate: CollapseCandidate) => string;
  /** Algorithm revision persisted with each decision. */
  private readonly algorithmVersion: string;
  /** Policy/config revision persisted with each decision. */
  private readonly configVersion: string;
  /** Summaries prepared but not yet visible to the model. */
  private staged: CollapseSpan[];
  /** Ordered committed replacements that drive read-time projection. */
  private commits: CollapseSpan[];
  /** Most recent observed transcript size. */
  private lastObservedTokens: number;
  /** Transcript size at the most recent staging operation. */
  private lastSpawnTokens: number;
  /** Next monotonic commit id used to validate dependency ordering. */
  private nextCommitSequence: number;

  constructor(options: CollapseControllerOptions) {
    this.thresholds = collapseThresholds(options.effectiveWindowTokens);
    this.summarizer = options.summarizer;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? ((candidate) => `collapse:${candidate.startEventId}:${candidate.endEventId}`);
    this.algorithmVersion = options.algorithmVersion ?? "collapse-v1";
    this.configVersion = options.configVersion ?? "v1";
    const restored = options.snapshot;
    this.staged = [...(restored?.staged ?? [])];
    this.commits = validateCommitLog(restored?.commits ?? []);
    this.lastObservedTokens = restored?.lastObservedTokens ?? 0;
    this.lastSpawnTokens = restored?.lastSpawnTokens ?? 0;
    this.nextCommitSequence = restored?.nextCommitSequence ?? this.commits.length + 1;
  }

  /** Spawns at most one summary per interval. Staging never changes the visible transcript. */
  async stageIfNeeded(input: {
    readonly tokens: number;
    readonly groups: readonly TurnGroup[];
    readonly messages: readonly AgentMessage[];
    readonly signal?: AbortSignal;
  }): Promise<CollapseSpan | undefined> {
    this.lastObservedTokens = input.tokens;
    if (input.tokens < this.thresholds.stageStartTokens) return undefined;
    if (this.lastSpawnTokens > 0 && input.tokens - this.lastSpawnTokens < this.thresholds.spawnIntervalTokens) return undefined;
    const occupied = new Set([...this.staged, ...this.commits].flatMap((span) => span.groupIds));
    const groups = input.groups.map((group) => occupied.has(group.id) ? { ...group, alreadyCollapsed: true } : group);
    const candidate = selectCollapseCandidates(groups, this.thresholds)[0];
    if (!candidate) return undefined;
    const result = await this.summarizer.summarize({
      candidate,
      groups,
      messages: input.messages,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const span: CollapseSpan = {
      id: this.idFactory(candidate), startEventId: candidate.startEventId, endEventId: candidate.endEventId,
      groupIds: candidate.groupIds, originalTokens: candidate.tokenCount, summary: result.summary,
      risk: candidate.informationRisk, state: "staged", stagedAt: this.now().toISOString(),
      algorithmVersion: this.algorithmVersion, configVersion: this.configVersion,
    };
    this.staged.push(span);
    this.lastSpawnTokens = input.tokens;
    return span;
  }

  /** Commits staged summaries in staging order until the target is reached. */
  commitIfNeeded(tokens: number): readonly CollapseSpan[] {
    this.lastObservedTokens = tokens;
    if (tokens < this.thresholds.commitThresholdTokens) return [];
    const committed: CollapseSpan[] = [];
    let projectedTokens = tokens;
    while (this.staged.length > 0 && projectedTokens > this.thresholds.commitTargetTokens) {
      const span = this.staged.shift()!;
      const sequence = this.nextCommitSequence++;
      const commit: CollapseSpan = {
        ...span, state: "committed", committedAt: this.now().toISOString(), commitSequence: sequence,
        ...(sequence > 1 ? { dependsOnCommitSequence: sequence - 1 } : {}),
      };
      this.commits.push(commit);
      committed.push(commit);
      projectedTokens -= Math.max(0, span.originalTokens);
    }
    return committed;
  }

  /** Overflow recovery drains every staged span, independently of the normal 90% threshold. */
  drain(): readonly CollapseSpan[] {
    const drained: CollapseSpan[] = [];
    while (this.staged.length > 0) {
      const span = this.staged.shift()!;
      const sequence = this.nextCommitSequence++;
      const commit: CollapseSpan = { ...span, state: "committed", committedAt: this.now().toISOString(),
        commitSequence: sequence, ...(sequence > 1 ? { dependsOnCommitSequence: sequence - 1 } : {}) };
      this.commits.push(commit);
      drained.push(commit);
    }
    return drained;
  }

  project(messages: readonly AgentMessage[]): readonly AgentMessage[] {
    let projected = [...messages];
    this.commits = this.commits.map((span) => {
      const start = projected.findIndex((message) => message.id === span.startEventId);
      const end = projected.findIndex((message) => message.id === span.endEventId);
      if (start < 0 || end < start) return span;
      const summary: AgentMessage = { id: `collapse-summary:${span.id}`, role: "system",
        content: [{ type: "text", text: span.summary }], metadata: { projection: "collapse", collapseId: span.id } };
      projected.splice(start, end - start + 1, summary);
      return span.state === "projected" ? span : { ...span, state: "projected" };
    });
    return projected;
  }

  isBlocking(tokens: number): boolean { return tokens >= this.thresholds.blockingThresholdTokens; }

  snapshot(): CollapseSnapshot {
    return { version: 1, lastObservedTokens: this.lastObservedTokens, lastSpawnTokens: this.lastSpawnTokens,
      nextCommitSequence: this.nextCommitSequence, staged: [...this.staged], commits: [...this.commits] };
  }
}

/** Bounded retry state for emergency context-overflow recovery. */
export interface OverflowRecoveryState {
  readonly collapseDrainAttempted: boolean;
  readonly reactiveCompactAttempted: boolean;
}

/** Escalates from ordinary Collapse to a bounded emergency reduction pass. */
export function recoverContextOverflow(input: {
  readonly state: OverflowRecoveryState;
  readonly drainCollapse: () => boolean;
  readonly reactiveCompact: () => boolean;
}): { readonly action: "collapse-drain-retry" | "reactive-compact-retry" | "fail"; readonly state: OverflowRecoveryState } {
  if (!input.state.collapseDrainAttempted) {
    const next = { ...input.state, collapseDrainAttempted: true };
    if (input.drainCollapse()) return { action: "collapse-drain-retry", state: next };
    input = { ...input, state: next };
  }
  if (!input.state.reactiveCompactAttempted) {
    const next = { ...input.state, reactiveCompactAttempted: true };
    if (input.reactiveCompact()) return { action: "reactive-compact-retry", state: next };
    return { action: "fail", state: next };
  }
  return { action: "fail", state: input.state };
}

function validateCommitLog(commits: readonly CollapseSpan[]): CollapseSpan[] {
  return commits.map((commit, index) => {
    const sequence = index + 1;
    if (commit.commitSequence !== sequence || (sequence > 1 && commit.dependsOnCommitSequence !== sequence - 1)) {
      throw new Error(`invalid collapse commit order at sequence ${sequence}`);
    }
    return commit;
  });
}
