import type { AgentMessage } from "../../protocol/message.js";
import { messageTokens, transcriptTokens, type TokenEstimator } from "./token-estimator.js";
import type { SessionMemory } from "./session-memory.js";
import {
  summarizeWithCircuitBreaker,
  summarizeWithCompactRetries,
  type AutoCompactCircuitBreaker,
  type CompactRetryDecision,
} from "./compact-resilience.js";

/** Model-generated replacement summary plus optional structured task state. */
export interface CompactSummary {
  readonly text: string;
  readonly model: string;
  readonly usage?: Readonly<Record<string, number>>;
}

/** Abstraction used to summarize a safe prefix without coupling to one provider. */
export interface CompactSummarizer {
  summarize(input: {
    readonly messages: readonly AgentMessage[];
    readonly sessionMemory?: SessionMemory;
    readonly instructions: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<CompactSummary>;
}

/** Host-owned state categories that must be restored after compaction. */
export interface RehydrationManifest {
  readonly compactedEventIds: readonly string[];
  readonly keptEventIds: readonly string[];
  readonly sourceRefs?: readonly string[];
}

/** Durable description of the removed prefix and first canonical entry retained. */
export interface CompactBoundary {
  readonly kind: "compact-boundary";
  readonly boundaryId: string;
  readonly firstKeptEventId?: string;
  readonly preCompactTokens: number;
  readonly postCompactTokens: number;
  readonly summaryModel: string;
  readonly algorithmVersion: string;
  readonly configVersion: string;
  readonly manifest: RehydrationManifest;
  readonly retryDecisions?: readonly CompactRetryDecision[];
}

/** Token policy, summarizer, and resilience controls for one Compact operation. */
export interface CompactOptions {
  readonly keepRecentTokens: number;
  readonly summarizer: CompactSummarizer;
  readonly sessionMemory?: SessionMemory;
  readonly estimator?: TokenEstimator;
  readonly boundaryId?: string;
  readonly signal?: AbortSignal;
  readonly circuitBreaker?: AutoCompactCircuitBreaker;
  readonly maxPromptTooLongRetries?: number;
  readonly maxStreamingRetries?: number;
  readonly algorithmVersion?: string;
  readonly configVersion?: string;
}

const SUMMARY_INSTRUCTIONS = [
  "Preserve user goals, completed work, key decisions and their reasons.",
  "Preserve changed files, failures, verification results, current state, pending tasks and blockers.",
  "Do not invent completion or verification.",
];

/** Replaces an old transcript prefix with a model summary and a rehydration manifest. */
export async function compactTranscript(
  messages: readonly AgentMessage[],
  options: CompactOptions,
): Promise<{ readonly messages: readonly AgentMessage[]; readonly boundary: CompactBoundary }> {
  const split = keepTailStart(messages, options.keepRecentTokens, options.estimator);
  if (split === 0) throw new Error("compact requires at least one older message outside the protected tail");
  const compacted = messages.slice(0, split);
  const kept = messages.slice(split);
  const resilientInput = {
    messages: compacted,
    instructions: SUMMARY_INSTRUCTIONS,
    ...(options.sessionMemory === undefined ? {} : { sessionMemory: options.sessionMemory }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxPromptTooLongRetries === undefined ? {} : { maxPromptTooLongRetries: options.maxPromptTooLongRetries }),
    ...(options.maxStreamingRetries === undefined ? {} : { maxStreamingRetries: options.maxStreamingRetries }),
    summarizer: options.summarizer,
  };
  const summaryResult = options.circuitBreaker
    ? await summarizeWithCircuitBreaker(options.circuitBreaker, resilientInput)
    : { status: "completed" as const, ...(await summarizeWithCompactRetries(resilientInput)) };
  if (summaryResult.status === "skipped") {
    throw new Error(`compact skipped: ${summaryResult.reason}`);
  }
  const { summary, decisions } = summaryResult;
  const boundaryId = options.boundaryId ?? `compact:${compacted[0]!.id}:${compacted.at(-1)!.id}`;
  const summaryMessage: AgentMessage = {
    id: `compact-summary:${boundaryId}`,
    role: "system",
    content: [{ type: "text", text: summary.text }],
    metadata: { projection: "compact-summary", boundaryId },
  };
  const projected = [summaryMessage, ...kept];
  const boundary: CompactBoundary = {
    kind: "compact-boundary",
    boundaryId,
    ...(kept[0] === undefined ? {} : { firstKeptEventId: kept[0].id }),
    preCompactTokens: transcriptTokens(messages, options.estimator),
    postCompactTokens: transcriptTokens(projected, options.estimator),
    summaryModel: summary.model,
    algorithmVersion: options.algorithmVersion ?? "compact-v1",
    configVersion: options.configVersion ?? "v1",
    manifest: { compactedEventIds: compacted.map((m) => m.id), keptEventIds: kept.map((m) => m.id) },
    ...(decisions.length === 0 ? {} : { retryDecisions: decisions }),
  };
  return { messages: projected, boundary };
}

function keepTailStart(messages: readonly AgentMessage[], minimumTokens: number, estimate?: TokenEstimator): number {
  let tokens = 0;
  let index = messages.length;
  while (index > 0 && tokens < minimumTokens) {
    index -= 1;
    tokens += messageTokens(messages[index]!, estimate);
  }
  // Pull matching tool call into the kept range when a kept result references it.
  const resultIds = new Set(messages.slice(index).flatMap((m) => m.content.flatMap((c) => c.type === "tool-result" ? [c.toolCallId] : [])));
  for (let cursor = index - 1; cursor >= 0 && resultIds.size > 0; cursor -= 1) {
    if (messages[cursor]!.content.some((c) => c.type === "tool-call" && resultIds.has(c.id))) index = cursor;
  }
  return index;
}
