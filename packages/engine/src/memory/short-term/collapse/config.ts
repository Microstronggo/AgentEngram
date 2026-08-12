/** Trigger and candidate-window thresholds for staged context collapse. */
export interface CollapseThresholds {
  readonly stageStartTokens: number;
  readonly spawnIntervalTokens: number;
  readonly commitThresholdTokens: number;
  readonly blockingThresholdTokens: number;
  readonly commitTargetTokens: number;
  readonly protectedTailTokens: number;
  readonly minimumSpanTokens: number;
  readonly maximumSpanTokens: number;
}

/** V1 defaults calculated against the effective context window. */
export function collapseThresholds(effectiveWindowTokens: number): CollapseThresholds {
  if (!Number.isFinite(effectiveWindowTokens) || effectiveWindowTokens <= 0) {
    throw new RangeError("effectiveWindowTokens must be a positive finite number");
  }

  const window = Math.floor(effectiveWindowTokens);
  if (window < 8_000) {
    throw new RangeError("effectiveWindowTokens below 8000 is unsupported");
  }
  const minimumSpanTokens = Math.max(4_000, Math.floor(window * 0.03));
  return {
    stageStartTokens: Math.floor(window * 0.7),
    spawnIntervalTokens: Math.max(8_000, Math.floor(window * 0.05)),
    commitThresholdTokens: Math.floor(window * 0.9),
    blockingThresholdTokens: Math.floor(window * 0.95),
    commitTargetTokens: Math.floor(window * 0.82),
    protectedTailTokens: Math.min(32_000, Math.max(8_000, Math.floor(window * 0.15))),
    minimumSpanTokens,
    maximumSpanTokens: Math.max(minimumSpanTokens, Math.floor(window * 0.15)),
  };
}
