import type { AgentMessage, ContextMode } from "../protocol/index.js";
import {
  applyToolResultBudget,
  compactTranscript,
  historySnip,
  microcompact,
  renderSessionMemory,
  transcriptTokens,
  type CollapseController,
  type CompactOptions,
  type MicrocompactOptions,
  type SessionMemory,
  type ToolResultBudgetOptions,
  type ToolResultBudgetState,
  type TurnGroup,
} from "../memory/short-term/index.js";
import { createMemoryContextMessage, type RecalledMemoryContext } from "./memory-context.js";
import type { ContextProjector, ProjectionInput } from "./context-projector.js";

/** Optional audit sink for durable short-term-memory projection decisions. */
export interface MemoryProjectionDecisionSink {
  append(kind: string, payload: unknown): void | Promise<void>;
}

/** Configures the complete short-term-memory projection sequence. */
export interface MemoryContextProjectorOptions {
  readonly toolResultBudget?: { readonly state: ToolResultBudgetState; readonly options: ToolResultBudgetOptions };
  readonly microcompact?: (input: ProjectionInput) => MicrocompactOptions;
  readonly historySnip?: (
    input: ProjectionInput,
    currentTokens: number,
  ) => { readonly targetTokensToFree: number; readonly protectedTailTokens: number } | undefined;
  readonly collapse?: CollapseController;
  readonly compact?: Omit<CompactOptions, "keepRecentTokens"> & { readonly keepRecentTokens?: number };
  readonly loadSessionMemory?: (sessionId: string) => Promise<SessionMemory | undefined>;
  readonly recall?: (input: { query: string; projectId?: string; limit: number }) => Promise<readonly RecalledMemoryContext[]>;
  readonly decisions?: MemoryProjectionDecisionSink;
}

/** Ordered read-time projection with explicit enhance and managed-context boundaries. */
export class MemoryContextProjector implements ContextProjector {
  /** Stable diagnostic name recorded by ContextPipeline. */
  readonly name = "agentengram-context-runtime";
  /** @param options Enabled short-term policies, recall source, and decision sink. */
  constructor(private readonly options: MemoryContextProjectorOptions) {}

  async project(input: ProjectionInput): Promise<readonly AgentMessage[]> {
    let messages = [...input.messages];
    if (input.mode === "managed-context") messages = await this.projectShortTerm(input, messages);
    messages = await this.injectMemory(input, messages);
    return messages;
  }

  private async projectShortTerm(input: ProjectionInput, source: readonly AgentMessage[]): Promise<AgentMessage[]> {
    let messages = [...source];
    // Destructive projections run only in managed mode and in cheapest-first order.
    if (this.options.toolResultBudget) {
      const result = await applyToolResultBudget(messages, this.options.toolResultBudget.state, this.options.toolResultBudget.options);
      messages = [...result.messages];
      for (const decision of result.decisions) await this.record(decision.kind, decision);
    }
    const currentTokens = transcriptTokens(messages);
    const snipOptions = this.options.historySnip?.(input, currentTokens);
    if (snipOptions) {
      const snip = historySnip(messages, {
        targetTokensToFree: snipOptions.targetTokensToFree,
        protectedTailTokens: snipOptions.protectedTailTokens,
      });
      messages = [...snip.messages];
      if (snip.decision) await this.record(snip.decision.kind, snip.decision);
    }

    if (this.options.microcompact) {
      const result = await microcompact(messages, this.options.microcompact(input));
      messages = [...result.messages];
      if (result.decision) await this.record(result.decision.kind, result.decision);
    }

    const window = input.request.contextWindow;
    if (this.options.collapse && window) {
      const groups = turnGroups(messages);
      const tokens = transcriptTokens(messages);
      const staged = await this.options.collapse.stageIfNeeded({ tokens, groups, messages });
      if (staged) await this.record("collapse.staged", staged);
      for (const committed of this.options.collapse.commitIfNeeded(tokens)) await this.record("collapse.committed", committed);
      messages = [...this.options.collapse.project(messages)];
    } else if (this.options.compact && window && transcriptTokens(messages) >= window * 0.9) {
      const compacted = await compactTranscript(messages, {
        ...this.options.compact,
        keepRecentTokens: this.options.compact.keepRecentTokens ?? Math.min(40_000, Math.floor(window * 0.2)),
      });
      messages = [...compacted.messages];
      await this.record("compact.completed", compacted.boundary);
    }
    return messages;
  }

  private async injectMemory(input: ProjectionInput, source: readonly AgentMessage[]): Promise<AgentMessage[]> {
    const injected: AgentMessage[] = [];
    const session = await this.options.loadSessionMemory?.(input.request.sessionId);
    if (session) injected.push({
      id: `agentengram:session:${input.request.sessionId}`,
      role: "user",
      content: [{ type: "text", text: `<session-memory>\n${renderSessionMemory(session)}\n</session-memory>` }],
      metadata: { dynamicMemory: true, sessionMemory: true },
    });
    if (this.options.recall) {
      const query = currentQuery(source);
      const projectId = typeof input.request.metadata?.projectId === "string" ? input.request.metadata.projectId : undefined;
      const memories = await this.options.recall({ query, ...(projectId ? { projectId } : {}), limit: 5 });
      const message = createMemoryContextMessage(memories);
      if (message) injected.push(message);
    }
    return injected.length === 0 ? [...source] : [...source, ...injected];
  }

  private async record(kind: string, payload: unknown): Promise<void> {
    await this.options.decisions?.append(kind, payload);
  }
}

function currentQuery(messages: readonly AgentMessage[]): string {
  const message = [...messages].reverse().find(({ role }) => role === "user");
  return message?.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n") ?? "";
}

function turnGroups(messages: readonly AgentMessage[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: AgentMessage[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const calls = new Set(current.flatMap((message) => message.content.flatMap((item) => item.type === "tool-call" ? [item.id] : [])));
    const results = new Set(current.flatMap((message) => message.content.flatMap((item) => item.type === "tool-result" ? [item.toolCallId] : [])));
    groups.push({
      id: `turn:${current[0]!.id}`,
      startEventId: current[0]!.id,
      endEventId: current.at(-1)!.id,
      tokenCount: transcriptTokens(current),
      currentRelevance: 0.25,
      hasCompleteToolPairs: [...calls].every((id) => results.has(id)),
      isCurrentTurn: false,
      isDynamicMemory: current.some((message) => message.metadata?.dynamicMemory === true),
    });
    current = [];
  };
  for (const message of messages) {
    if (message.role === "user" && current.length > 0) flush();
    current.push(message);
  }
  flush();
  if (groups.length > 0) groups[groups.length - 1] = { ...groups.at(-1)!, isCurrentTurn: true };
  return groups;
}
