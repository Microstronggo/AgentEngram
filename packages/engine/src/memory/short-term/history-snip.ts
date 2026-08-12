import type { AgentMessage } from "../../protocol/message.js";
import { messageTokens, type TokenEstimator } from "./token-estimator.js";

/** Replayable replacement of one stale tool result with a compact preview. */
export interface SnipDecision {
  readonly kind: "history-snip";
  readonly decisionId: string;
  readonly removedEventIds: readonly string[];
  readonly startEventId: string;
  readonly endEventId: string;
  readonly tokensFreed: number;
  readonly rewiredParentByEventId: Readonly<Record<string, string | undefined>>;
  readonly algorithmVersion: string;
  readonly configVersion: string;
}

/** Age, size, and preview policy for selective History Snip. */
export interface HistorySnipOptions {
  readonly targetTokensToFree: number;
  readonly protectedTailTokens: number;
  readonly protectedMessageIds?: ReadonlySet<string>;
  readonly estimator?: TokenEstimator;
  readonly idFactory?: () => string;
  readonly algorithmVersion?: string;
  readonly configVersion?: string;
}

/** Deterministically removes one old contiguous interval without a model call. */
export function historySnip(
  messages: readonly AgentMessage[],
  options: HistorySnipOptions,
): { readonly messages: readonly AgentMessage[]; readonly decision?: SnipDecision; readonly boundaryMessage?: AgentMessage } {
  if (options.targetTokensToFree <= 0 || messages.length < 3) return { messages };
  const estimate = options.estimator;
  const protectedIds = new Set(options.protectedMessageIds);
  let tailTokens = 0;
  let tailStart = messages.length;
  while (tailStart > 0 && tailTokens < options.protectedTailTokens) {
    tailStart -= 1;
    tailTokens += messageTokens(messages[tailStart]!, estimate);
  }
  // Keep the first message (usually system/task context) and never cut an active tool pair.
  const activePairIds = activeToolPairMessageIds(messages);
  let start = 1;
  while (start < tailStart && (protectedIds.has(messages[start]!.id) || activePairIds.has(messages[start]!.id))) start += 1;
  let end = start;
  let freed = 0;
  while (end < tailStart && freed < options.targetTokensToFree) {
    const message = messages[end]!;
    if (protectedIds.has(message.id) || activePairIds.has(message.id)) break;
    freed += messageTokens(message, estimate);
    end += 1;
  }
  if (end === start || freed < options.targetTokensToFree) return { messages };
  const removed = messages.slice(start, end);
  const decisionId = options.idFactory?.() ?? `snip-${removed[0]!.id}-${removed.at(-1)!.id}`;
  const predecessorId = messages[start - 1]?.id;
  const rewired: Record<string, string | undefined> = {};
  if (messages[end]) rewired[messages[end]!.id] = predecessorId;
  const decision: SnipDecision = {
    kind: "history-snip",
    decisionId,
    removedEventIds: removed.map((message) => message.id),
    startEventId: removed[0]!.id,
    endEventId: removed.at(-1)!.id,
    tokensFreed: freed,
    rewiredParentByEventId: rewired,
    algorithmVersion: options.algorithmVersion ?? "history-snip-v1",
    configVersion: options.configVersion ?? "v1",
  };
  const boundaryMessage: AgentMessage = {
    id: `snip-boundary:${decisionId}`,
    role: "system",
    content: [{ type: "text", text: `[History snipped: ${decisionId}; ${removed.length} events recoverable by ID]` }],
    metadata: { projection: "history-snip", decisionId, removedEventIds: decision.removedEventIds },
  };
  return { messages: [...messages.slice(0, start), boundaryMessage, ...messages.slice(end)], decision, boundaryMessage };
}

/** Reapplies a persisted Snip decision without rerunning candidate selection. */
export function replaySnip(messages: readonly AgentMessage[], decision: SnipDecision): readonly AgentMessage[] {
  const removed = new Set(decision.removedEventIds);
  return messages.filter((message) => !removed.has(message.id));
}

function activeToolPairMessageIds(messages: readonly AgentMessage[]): Set<string> {
  const calls = new Map<string, string>();
  const completed = new Set<string>();
  for (const message of messages) for (const content of message.content) {
    if (content.type === "tool-call") calls.set(content.id, message.id);
    if (content.type === "tool-result") completed.add(content.toolCallId);
  }
  const unresolvedMessageIds = new Set([...calls].filter(([id]) => !completed.has(id)).map(([, messageId]) => messageId));
  const firstActive = messages.findIndex((message) => unresolvedMessageIds.has(message.id));
  // An unresolved call marks the active execution frontier; protect it and everything after it.
  return firstActive < 0 ? new Set() : new Set(messages.slice(firstActive).map((message) => message.id));
}
