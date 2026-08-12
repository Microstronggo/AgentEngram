import type { AgentMessage, ToolResultContent } from "../../protocol/message.js";
import { roughTokenEstimate, type TokenEstimator } from "./token-estimator.js";

/** Blob-backed replacement for a tool result that exceeded its context budget. */
export interface ToolResultReference {
  readonly uri: string;
  readonly preview?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Storage bridge used before replacing oversized tool output. */
export interface ToolResultOffloader {
  put(toolCallId: string, output: unknown): Promise<ToolResultReference>;
}

/** Replayable record of one tool output offload and placeholder replacement. */
export interface ToolResultReplacementDecision {
  readonly kind: "tool-result-replacement";
  readonly toolCallId: string;
  readonly replacement: ToolResultContent;
  readonly originalTokens: number;
  readonly algorithmVersion: string;
  readonly configVersion: string;
}

/** Per-thread idempotence state for outputs already offloaded. */
export interface ToolResultBudgetState {
  readonly seenIds: Set<string>;
  readonly replacements: Map<string, ToolResultReplacementDecision>;
}

/** Hard per-message budget and durable offloader configuration. */
export interface ToolResultBudgetOptions {
  readonly maxTokensPerMessage: number;
  readonly offloader: ToolResultOffloader;
  readonly estimator?: TokenEstimator;
  readonly skipToolNames?: ReadonlySet<string>;
  readonly algorithmVersion?: string;
  readonly configVersion?: string;
}

/** Creates replay state that makes repeated projections reuse the same replacement. */
export function createToolResultBudgetState(
  decisions: readonly ToolResultReplacementDecision[] = [],
): ToolResultBudgetState {
  return {
    seenIds: new Set(decisions.map((decision) => decision.toolCallId)),
    replacements: new Map(decisions.map((decision) => [decision.toolCallId, decision])),
  };
}

/** Restores serialized replacement decisions during checkpoint recovery. */
export function restoreToolResultBudgetState(
  messages: readonly AgentMessage[],
  decisions: readonly ToolResultReplacementDecision[],
): ToolResultBudgetState {
  const state = createToolResultBudgetState(decisions);
  for (const message of messages) {
    for (const content of message.content) {
      if (content.type === "tool-result") state.seenIds.add(content.toolCallId);
    }
  }
  return state;
}

/** Offloads oversized tool results while preserving tool-call/result pairing. */
export async function applyToolResultBudget(
  messages: readonly AgentMessage[],
  state: ToolResultBudgetState,
  options: ToolResultBudgetOptions,
): Promise<{ readonly messages: readonly AgentMessage[]; readonly decisions: readonly ToolResultReplacementDecision[] }> {
  if (options.maxTokensPerMessage <= 0) throw new RangeError("maxTokensPerMessage must be positive");
  const estimate = options.estimator ?? roughTokenEstimate;
  const toolNames = toolNamesByCallId(messages);
  const replacementById = new Map<string, ToolResultContent>();
  const freshDecisions: ToolResultReplacementDecision[] = [];

  for (const message of messages) {
    const results = message.content.filter(
      (content): content is ToolResultContent => content.type === "tool-result",
    );
    const candidates = results.map((content) => ({ content, tokens: estimate(content.output) }));
    for (const { content } of candidates) {
      const prior = state.replacements.get(content.toolCallId);
      if (prior) replacementById.set(content.toolCallId, prior.replacement);
    }
    const frozenTokens = candidates
      .filter(({ content }) => state.seenIds.has(content.toolCallId) && !state.replacements.has(content.toolCallId))
      .reduce((sum, item) => sum + item.tokens, 0);
    const fresh = candidates.filter(({ content }) => !state.seenIds.has(content.toolCallId));
    const eligible = fresh.filter(({ content }) => !options.skipToolNames?.has(toolNames.get(content.toolCallId) ?? ""));
    let remaining = frozenTokens + eligible.reduce((sum, item) => sum + item.tokens, 0);
    const selected = [...eligible].sort((a, b) => b.tokens - a.tokens).filter((item) => {
      if (remaining <= options.maxTokensPerMessage) return false;
      remaining -= item.tokens;
      return true;
    });
    const selectedIds = new Set(selected.map(({ content }) => content.toolCallId));
    for (const { content } of fresh) if (!selectedIds.has(content.toolCallId)) state.seenIds.add(content.toolCallId);

    const offloaded = await Promise.all(selected.map(async ({ content, tokens }) => {
      try {
        const reference = await options.offloader.put(content.toolCallId, content.output);
        const replacement: ToolResultContent = {
          type: "tool-result",
          toolCallId: content.toolCallId,
          output: reference.preview ?? `[Tool result offloaded: ${reference.uri}]`,
          ...(content.isError === undefined ? {} : { isError: content.isError }),
        };
        return { content, decision: {
          kind: "tool-result-replacement" as const,
          toolCallId: content.toolCallId,
          replacement,
          originalTokens: tokens,
          algorithmVersion: options.algorithmVersion ?? "tool-budget-v1",
          configVersion: options.configVersion ?? "v1",
        } };
      } catch {
        return { content, decision: undefined };
      }
    }));
    for (const { content, decision } of offloaded) {
      state.seenIds.add(content.toolCallId);
      if (!decision) continue;
      state.replacements.set(content.toolCallId, decision);
      replacementById.set(content.toolCallId, decision.replacement);
      freshDecisions.push(decision);
    }
  }

  if (replacementById.size === 0) return { messages, decisions: freshDecisions };
  return {
    messages: messages.map((message) => ({
      ...message,
      content: message.content.map((content) =>
        content.type === "tool-result" ? replacementById.get(content.toolCallId) ?? content : content,
      ),
    })),
    decisions: freshDecisions,
  };
}

function toolNamesByCallId(messages: readonly AgentMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) for (const content of message.content) {
    if (content.type === "tool-call") names.set(content.id, content.name);
  }
  return names;
}
