import { describe, expect, it } from "vitest";
import {
  collapseThresholds,
  informationRisk,
  selectCollapseCandidates,
  type TurnGroup,
} from "./index.js";

function group(id: string, overrides: Partial<TurnGroup> = {}): TurnGroup {
  return {
    id,
    startEventId: `${id}-start`,
    endEventId: `${id}-end`,
    tokenCount: 2_000,
    currentRelevance: 0.2,
    hasCompleteToolPairs: true,
    ...overrides,
  };
}

describe("collapseThresholds", () => {
  it("fixes the V1 ratios and formulas", () => {
    expect(collapseThresholds(200_000)).toEqual({
      stageStartTokens: 140_000,
      spawnIntervalTokens: 10_000,
      commitThresholdTokens: 180_000,
      blockingThresholdTokens: 190_000,
      commitTargetTokens: 164_000,
      protectedTailTokens: 30_000,
      minimumSpanTokens: 6_000,
      maximumSpanTokens: 30_000,
    });
    expect(collapseThresholds(32_000).protectedTailTokens).toBe(8_000);
    expect(collapseThresholds(1_000_000).protectedTailTokens).toBe(32_000);
  });

  it("rejects windows too small for the V1 protected-tail invariants", () => {
    expect(() => collapseThresholds(7_999)).toThrow(RangeError);
  });
});

describe("selectCollapseCandidates", () => {
  const thresholds = {
    protectedTailTokens: 2_000,
    minimumSpanTokens: 4_000,
    maximumSpanTokens: 8_000,
  };

  it("only selects complete contiguous TurnGroup boundaries", () => {
    const groups = [group("a"), group("b"), group("c"), group("tail")];
    const candidates = selectCollapseCandidates(groups, thresholds);
    expect(candidates.some((candidate) => candidate.groupIds.join(",") === "a,b,c")).toBe(true);
    expect(candidates.every((candidate) => !candidate.groupIds.includes("tail"))).toBe(true);
    expect(candidates[0]?.startEventId.endsWith("-start")).toBe(true);
    expect(candidates[0]?.endEventId.endsWith("-end")).toBe(true);
  });

  it.each([
    { hasCompleteToolPairs: false },
    { isCurrentTurn: true },
    { isDynamicMemory: true },
    { crossesCompactBoundary: true },
    { alreadyCollapsed: true },
  ])("excludes an illegal group and does not cross it: %o", (illegal) => {
    const candidates = selectCollapseCandidates(
      [group("a"), group("blocked", illegal), group("c"), group("tail")],
      thresholds,
    );
    expect(candidates).toHaveLength(0);
  });

  it("penalizes relevant and high-risk spans", () => {
    const candidates = selectCollapseCandidates(
      [
        group("safe-a", { currentRelevance: 0 }),
        group("safe-b", { currentRelevance: 0 }),
        group("risky-a", { currentRelevance: 1, riskFlags: ["user-correction"] }),
        group("risky-b", { currentRelevance: 1, riskFlags: ["architecture-decision"] }),
        group("tail"),
      ],
      thresholds,
    );
    expect(candidates[0]?.groupIds).toEqual(["safe-a", "safe-b"]);
    expect(informationRisk(["explicitly-preserved"])).toBe(1);
  });
});
