import type { AgentMessage } from "../../protocol/message.js";
import { messageTokens, transcriptTokens, type TokenEstimator } from "./token-estimator.js";
import { renderSessionMemory, type SessionMemory } from "./session-memory.js";
import type { CompactBoundary } from "./compact.js";

/** Thresholds for replacing a transcript prefix with structured session state. */
export interface SessionMemoryCompactionConfig {
  readonly minTokens: number;
  readonly minTextBlockMessages: number;
  readonly maxTokens: number;
  readonly maxSummaryTokens?: number;
}

/** Conservative defaults that preserve a recent canonical tail. */
export const DEFAULT_SESSION_MEMORY_COMPACTION_CONFIG: SessionMemoryCompactionConfig = {
  minTokens: 10_000,
  minTextBlockMessages: 5,
  maxTokens: 40_000,
  maxSummaryTokens: 12_000,
};

/** Session snapshot and threshold overrides for one compaction attempt. */
export interface SessionMemoryCompactionOptions {
  readonly sessionMemory: SessionMemory;
  readonly estimator?: TokenEstimator;
  readonly config?: Partial<SessionMemoryCompactionConfig>;
  readonly autoCompactThresholdTokens?: number;
  readonly boundaryId?: string;
  readonly algorithmVersion?: string;
  readonly configVersion?: string;
}

/** Builds a Compact result without another model call when session state is sufficient. */
export function compactFromSessionMemory(
  messages: readonly AgentMessage[],
  options: SessionMemoryCompactionOptions,
): { readonly messages: readonly AgentMessage[]; readonly boundary: CompactBoundary } | undefined {
  if (isEmptySessionMemory(options.sessionMemory)) return undefined;
  const config = { ...DEFAULT_SESSION_MEMORY_COMPACTION_CONFIG, ...options.config };
  const estimator = options.estimator;
  const start = calculateSessionMemoryKeepStart(messages, options.sessionMemory, config, estimator);
  const kept = messages.slice(start).filter((message) => !isCompactBoundary(message));
  const summaryText = truncateSummary(renderSessionMemory(options.sessionMemory), config.maxSummaryTokens, estimator);
  const compacted = messages.slice(0, start);
  const boundaryId = options.boundaryId ?? `session-memory-compact:${messages[0]?.id ?? "empty"}:${kept[0]?.id ?? "tail"}`;
  const summaryMessage: AgentMessage = {
    id: `compact-summary:${boundaryId}`,
    role: "system",
    content: [{ type: "text", text: summaryText }],
    metadata: {
      projection: "compact-summary",
      boundaryId,
      sessionMemory: true,
      summarizedThroughEventId: options.sessionMemory.summarizedThroughEventId,
    },
  };
  const projected = [summaryMessage, ...kept];
  const postCompactTokens = transcriptTokens(projected, estimator);
  if (options.autoCompactThresholdTokens !== undefined && postCompactTokens >= options.autoCompactThresholdTokens) {
    return undefined;
  }
  const boundary: CompactBoundary = {
    kind: "compact-boundary",
    boundaryId,
    ...(kept[0] === undefined ? {} : { firstKeptEventId: kept[0].id }),
    preCompactTokens: transcriptTokens(messages, estimator),
    postCompactTokens,
    summaryModel: "session-memory",
    algorithmVersion: options.algorithmVersion ?? "session-memory-compact-v1",
    configVersion: options.configVersion ?? "v1",
    manifest: {
      compactedEventIds: compacted.map((message) => message.id),
      keptEventIds: kept.map((message) => message.id),
      sourceRefs: options.sessionMemory.summarizedThroughEventId ? [options.sessionMemory.summarizedThroughEventId] : [],
    },
  };
  return { messages: projected, boundary };
}

/** Finds a safe retained-tail boundary without splitting tool call/result pairs. */
export function calculateSessionMemoryKeepStart(
  messages: readonly AgentMessage[],
  memory: Pick<SessionMemory, "summarizedThroughEventId">,
  config: SessionMemoryCompactionConfig = DEFAULT_SESSION_MEMORY_COMPACTION_CONFIG,
  estimator?: TokenEstimator,
): number {
  const summarizedIndex = memory.summarizedThroughEventId
    ? messages.findIndex((message) => message.id === memory.summarizedThroughEventId)
    : messages.length - 1;
  if (memory.summarizedThroughEventId && summarizedIndex < 0) return 0;
  const floor = lastCompactBoundaryIndex(messages) + 1;
  let start = Math.max(floor, summarizedIndex + 1);
  let tokens = transcriptTokens(messages.slice(start), estimator);
  let textMessages = countTextMessages(messages.slice(start));
  if (tokens >= config.maxTokens) return adjustStartForProtocolInvariants(messages, start);
  while (start > floor && (tokens < config.minTokens || textMessages < config.minTextBlockMessages)) {
    const next = messages[start - 1]!;
    const nextTokens = messageTokens(next, estimator);
    if (tokens + nextTokens > config.maxTokens && (tokens >= config.minTokens || textMessages >= config.minTextBlockMessages)) break;
    start -= 1;
    tokens += nextTokens;
    if (hasText(next)) textMessages += 1;
  }
  return adjustStartForProtocolInvariants(messages, start);
}

function adjustStartForProtocolInvariants(messages: readonly AgentMessage[], start: number): number {
  let adjusted = start;
  const kept = messages.slice(adjusted);
  const existingCalls = new Set(kept.flatMap((message) => message.content.flatMap((content) => content.type === "tool-call" ? [content.id] : [])));
  const neededResults = new Set(kept.flatMap((message) =>
    message.content.flatMap((content) => content.type === "tool-result" && !existingCalls.has(content.toolCallId) ? [content.toolCallId] : []),
  ));
  for (let index = adjusted - 1; index >= 0 && neededResults.size > 0; index -= 1) {
    const found = messages[index]!.content.filter((content) => content.type === "tool-call" && neededResults.has(content.id));
    if (found.length > 0) {
      adjusted = index;
      for (const content of found) if (content.type === "tool-call") neededResults.delete(content.id);
    }
  }

  const providerIds = new Set(messages.slice(adjusted).flatMap(providerMessageId));
  for (let index = adjusted - 1; index >= 0; index -= 1) {
    const ids = providerMessageId(messages[index]!);
    if (ids.some((id) => providerIds.has(id))) adjusted = index;
  }
  return adjusted;
}

function providerMessageId(message: AgentMessage): string[] {
  const id = message.metadata?.providerMessageId ?? message.metadata?.messageId;
  return typeof id === "string" ? [id] : [];
}

function countTextMessages(messages: readonly AgentMessage[]): number {
  return messages.filter(hasText).length;
}

function hasText(message: AgentMessage): boolean {
  return message.content.some((content) => content.type === "text" && content.text.trim().length > 0);
}

function lastCompactBoundaryIndex(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isCompactBoundary(messages[index]!)) return index;
  }
  return -1;
}

function isCompactBoundary(message: AgentMessage): boolean {
  return message.metadata?.projection === "compact-summary" || message.metadata?.projection === "compact-boundary";
}

function truncateSummary(text: string, maxTokens: number | undefined, estimator: TokenEstimator | undefined): string {
  if (maxTokens === undefined || messageTokens({ id: "summary", role: "system", content: [{ type: "text", text }] }, estimator) <= maxTokens) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const next = [...kept, line, "[... session memory truncated for compact ...]"].join("\n");
    if (messageTokens({ id: "summary", role: "system", content: [{ type: "text", text: next }] }, estimator) > maxTokens) break;
    kept.push(line);
  }
  return `${kept.join("\n")}\n[... session memory truncated for compact ...]`;
}

function isEmptySessionMemory(memory: SessionMemory): boolean {
  return [
    memory.goals, memory.constraints, memory.decisions, memory.activeFiles,
    memory.completedWork, memory.failedAttempts, memory.pendingTasks, memory.blockers,
  ].every((items) => items.length === 0);
}
