import type { AgentMessage } from "../../protocol/message.js";
import { messageTokens, type TokenEstimator } from "./token-estimator.js";

/** Host data sources that may be restored after a destructive compaction. */
export type RehydrationSourceKind = "plan" | "recent-file" | "skill" | "tool" | "hook" | "async-agent";

/** One bounded, provenance-labelled item eligible for reinjection. */
export interface RehydrationItem {
  readonly id: string;
  readonly kind: RehydrationSourceKind;
  readonly priority?: number;
  readonly message: AgentMessage;
  readonly sourceRef: string;
}

/** Host bridge that resolves one manifest source into current data. */
export interface RehydrationProvider {
  readonly kind: RehydrationSourceKind;
  load(): Promise<readonly RehydrationItem[]>;
}

/** Observable delivery result for one post-compact rehydration run. */
export interface RehydrationDecision {
  readonly itemId: string;
  readonly kind: RehydrationSourceKind;
  readonly sourceRef: string;
  readonly tokens: number;
  readonly included: boolean;
  readonly reason?: "budget-exceeded";
}

/** Providers and token limits for post-compact state restoration. */
export interface RehydrationExecutorOptions {
  readonly providers: readonly RehydrationProvider[];
  readonly totalBudgetTokens: number;
  readonly perKindBudgetTokens?: Partial<Record<RehydrationSourceKind, number>>;
  readonly estimator?: TokenEstimator;
}

const KIND_ORDER: RehydrationSourceKind[] = ["plan", "recent-file", "skill", "tool", "hook", "async-agent"];

export async function executeRehydration(
  options: RehydrationExecutorOptions,
): Promise<{ readonly messages: readonly AgentMessage[]; readonly decisions: readonly RehydrationDecision[] }> {
  const items = (await Promise.all(options.providers.map((provider) => provider.load()))).flat()
    .sort((left, right) =>
      (KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind)) ||
      (right.priority ?? 0) - (left.priority ?? 0),
    );
  const usedByKind = new Map<RehydrationSourceKind, number>();
  const messages: AgentMessage[] = [];
  const decisions: RehydrationDecision[] = [];
  let used = 0;
  for (const item of items) {
    const tokens = messageTokens(item.message, options.estimator);
    const kindUsed = usedByKind.get(item.kind) ?? 0;
    const kindBudget = options.perKindBudgetTokens?.[item.kind] ?? Number.POSITIVE_INFINITY;
    if (used + tokens > options.totalBudgetTokens || kindUsed + tokens > kindBudget) {
      decisions.push({ itemId: item.id, kind: item.kind, sourceRef: item.sourceRef, tokens, included: false, reason: "budget-exceeded" });
      continue;
    }
    messages.push({
      ...item.message,
      metadata: {
        ...item.message.metadata,
        rehydrated: true,
        rehydrationKind: item.kind,
        sourceRef: item.sourceRef,
      },
    });
    used += tokens;
    usedByKind.set(item.kind, kindUsed + tokens);
    decisions.push({ itemId: item.id, kind: item.kind, sourceRef: item.sourceRef, tokens, included: true });
  }
  return { messages, decisions };
}
