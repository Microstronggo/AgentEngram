import type { AgentMessage, MessageContent } from "../protocol/index.js";

/** Input-window budget after reserving model output capacity. */
export interface ContextTokenBudget {
  readonly contextWindow: number;
  readonly reservedOutputTokens?: number;
  readonly safetyMarginTokens?: number;
}

/** Per-segment allocation produced from one context-window budget. */
export interface BudgetAllocation {
  readonly messages: readonly AgentMessage[];
  readonly estimatedTokens: number;
  readonly limitTokens: number;
  readonly removedMessageIds: readonly string[];
}

/** Deterministic provider-neutral estimate. Adapters may replace it with a model tokenizer. */
export function estimateMessageTokens(message: AgentMessage): number {
  const characters = message.content.reduce((total, item) => total + contentCharacters(item), 0);
  return Math.max(4, Math.ceil(characters / 4) + 4);
}

/** Divides the usable input budget across system, memory, tools, and history. */
export function allocateContextBudget(
  messages: readonly AgentMessage[],
  budget: ContextTokenBudget,
): BudgetAllocation {
  const window = positiveInteger(budget.contextWindow, "contextWindow");
  const reserved = Math.max(0, Math.floor(budget.reservedOutputTokens ?? 0));
  const margin = Math.max(0, Math.floor(budget.safetyMarginTokens ?? Math.min(8_000, window * 0.05)));
  const limitTokens = Math.max(1, window - reserved - margin);
  const costs = messages.map(estimateMessageTokens);
  let total = costs.reduce((sum, value) => sum + value, 0);
  if (total <= limitTokens) return { messages, estimatedTokens: total, limitTokens, removedMessageIds: [] };

  const protectedIndexes = protectedMessageIndexes(messages);
  const linkedIndexes = linkedToolPairIndexes(messages);
  const kept = messages.map(() => true);
  const removedMessageIds: string[] = [];
  for (let index = 0; index < messages.length && total > limitTokens; index += 1) {
    if (!kept[index]) continue;
    const group = linkedIndexes.get(index) ?? new Set([index]);
    if ([...group].some((item) => protectedIndexes.has(item))) continue;
    for (const item of group) {
      if (!kept[item]) continue;
      kept[item] = false;
      total -= costs[item] ?? 0;
      removedMessageIds.push(messages[item]!.id);
    }
  }
  if (total > limitTokens) throw new RangeError("protected context exceeds the hard token budget");
  return {
    messages: messages.filter((_, index) => kept[index]),
    estimatedTokens: total,
    limitTokens,
    removedMessageIds,
  };
}

function protectedMessageIndexes(messages: readonly AgentMessage[]): Set<number> {
  const protectedIndexes = new Set<number>();
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser >= 0) protectedIndexes.add(lastUser);
  for (let index = Math.max(0, messages.length - 2); index < messages.length; index += 1) {
    protectedIndexes.add(index);
  }
  const calls = new Map<string, number>();
  const completed = new Set<string>();
  messages.forEach((message, index) => message.content.forEach((item) => {
    if (item.type === "tool-call") calls.set(item.id, index);
    if (item.type === "tool-result") completed.add(item.toolCallId);
  }));
  const unresolved = [...calls].filter(([id]) => !completed.has(id)).map(([, index]) => index);
  const frontier = unresolved.length ? Math.min(...unresolved) : -1;
  if (frontier >= 0) for (let index = frontier; index < messages.length; index += 1) protectedIndexes.add(index);
  return protectedIndexes;
}

function linkedToolPairIndexes(messages: readonly AgentMessage[]): Map<number, Set<number>> {
  const callIndexes = new Map<string, number>();
  const adjacency = new Map<number, Set<number>>();
  messages.forEach((message, index) => message.content.forEach((item) => {
    if (item.type === "tool-call") callIndexes.set(item.id, index);
    if (item.type !== "tool-result") return;
    const call = callIndexes.get(item.toolCallId);
    if (call === undefined) return;
    (adjacency.get(call) ?? setAt(adjacency, call)).add(index);
    (adjacency.get(index) ?? setAt(adjacency, index)).add(call);
  }));
  const groups = new Map<number, Set<number>>();
  for (const start of adjacency.keys()) {
    if (groups.has(start)) continue;
    const group = new Set<number>();
    const stack = [start];
    while (stack.length) {
      const current = stack.pop()!;
      if (group.has(current)) continue;
      group.add(current);
      stack.push(...(adjacency.get(current) ?? []));
    }
    for (const index of group) groups.set(index, group);
  }
  return groups;
}

function setAt(map: Map<number, Set<number>>, key: number): Set<number> {
  const value = new Set<number>();
  map.set(key, value);
  return value;
}

function contentCharacters(content: MessageContent): number {
  if (content.type === "text") return content.text.length;
  if (content.type === "tool-call") return content.name.length + JSON.stringify(content.arguments).length;
  return JSON.stringify(content.output).length;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return Math.floor(value);
}
