import type { CollapseThresholds } from "./config.js";

/** Structural condition that makes a turn unsafe or expensive to collapse. */
export type CollapseRiskFlag =
  | "user-correction"
  | "architecture-decision"
  | "unresolved-error"
  | "active-todo"
  | "file-modification"
  | "unverified-implementation"
  | "explicitly-preserved";

/** User-led message group treated as one indivisible Collapse unit. */
export interface TurnGroup {
  readonly id: string;
  readonly startEventId: string;
  readonly endEventId: string;
  readonly tokenCount: number;
  readonly currentRelevance: number;
  readonly riskFlags?: readonly CollapseRiskFlag[];
  readonly hasCompleteToolPairs: boolean;
  readonly isCurrentTurn?: boolean;
  readonly isDynamicMemory?: boolean;
  readonly crossesCompactBoundary?: boolean;
  readonly alreadyCollapsed?: boolean;
}

/** Scored contiguous turn window proposed to the Collapse state machine. */
export interface CollapseCandidate {
  readonly startGroupIndex: number;
  readonly endGroupIndex: number;
  readonly startEventId: string;
  readonly endEventId: string;
  readonly groupIds: readonly string[];
  readonly tokenCount: number;
  readonly informationRisk: number;
  readonly currentRelevance: number;
  readonly score: number;
}

const RISK_WEIGHT: Readonly<Record<CollapseRiskFlag, number>> = {
  "user-correction": 0.95,
  "architecture-decision": 0.85,
  "unresolved-error": 0.9,
  "active-todo": 0.9,
  "file-modification": 0.75,
  "unverified-implementation": 0.8,
  "explicitly-preserved": 1,
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Multiple risk flags use the highest risk: duplicated labels must not inflate risk. */
export function informationRisk(flags: readonly CollapseRiskFlag[] = []): number {
  return flags.reduce((risk, flag) => Math.max(risk, RISK_WEIGHT[flag]), 0);
}

/** Rejects spans that could break active work, provenance, or tool-pair invariants. */
export function isEligibleTurnGroup(group: TurnGroup): boolean {
  return (
    group.tokenCount > 0 &&
    group.hasCompleteToolPairs &&
    !group.isCurrentTurn &&
    !group.isDynamicMemory &&
    !group.crossesCompactBoundary &&
    !group.alreadyCollapsed
  );
}

/**
 * Enumerates legal contiguous spans and ranks them by age, size, relevance and risk.
 * The returned spans always begin and end on TurnGroup boundaries.
 */
export function selectCollapseCandidates(
  groups: readonly TurnGroup[],
  thresholds: Pick<
    CollapseThresholds,
    "protectedTailTokens" | "minimumSpanTokens" | "maximumSpanTokens"
  >,
): readonly CollapseCandidate[] {
  const protectedIndexes = protectedTailIndexes(groups, thresholds.protectedTailTokens);
  const candidates: CollapseCandidate[] = [];
  const ageDenominator = Math.max(1, groups.length - 1);

  for (let start = 0; start < groups.length; start += 1) {
    const first = groups[start];
    if (first === undefined || protectedIndexes.has(start) || !isEligibleTurnGroup(first)) continue;

    let tokens = 0;
    let relevanceWeighted = 0;
    let riskWeighted = 0;
    const ids: string[] = [];

    for (let end = start; end < groups.length; end += 1) {
      const group = groups[end];
      if (group === undefined || protectedIndexes.has(end) || !isEligibleTurnGroup(group)) break;

      tokens += group.tokenCount;
      if (tokens > thresholds.maximumSpanTokens) break;
      relevanceWeighted += clamp01(group.currentRelevance) * group.tokenCount;
      riskWeighted += informationRisk(group.riskFlags) * group.tokenCount;
      ids.push(group.id);

      if (tokens < thresholds.minimumSpanTokens) continue;

      const relevance = relevanceWeighted / tokens;
      const risk = riskWeighted / tokens;
      const midpoint = (start + end) / 2;
      const age = 1 - midpoint / ageDenominator;
      const tokenSize = clamp01(tokens / thresholds.maximumSpanTokens);
      const score =
        0.35 * clamp01(age) +
        0.3 * tokenSize +
        0.2 * (1 - relevance) +
        0.15 * (1 - risk);

      candidates.push({
        startGroupIndex: start,
        endGroupIndex: end,
        startEventId: first.startEventId,
        endEventId: group.endEventId,
        groupIds: [...ids],
        tokenCount: tokens,
        informationRisk: risk,
        currentRelevance: relevance,
        score,
      });
    }
  }

  return candidates.sort(
    (left, right) => right.score - left.score || left.startGroupIndex - right.startGroupIndex,
  );
}

function protectedTailIndexes(groups: readonly TurnGroup[], protectedTokens: number): Set<number> {
  const indexes = new Set<number>();
  let tokens = 0;
  for (let index = groups.length - 1; index >= 0 && tokens < protectedTokens; index -= 1) {
    const group = groups[index];
    if (group === undefined) continue;
    indexes.add(index);
    tokens += Math.max(0, group.tokenCount);
  }
  return indexes;
}
