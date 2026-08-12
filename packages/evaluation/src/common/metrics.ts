import type { CutoffMetrics, EvaluationItem, GroupMetrics } from "./schema.js";

export function computeMetricsByCutoff(
  evaluations: readonly EvaluationItem[],
  cutoffs: readonly string[],
): Readonly<Record<string, CutoffMetrics>> {
  const output: Record<string, CutoffMetrics> = {};
  for (const cutoff of cutoffs) {
    const allScores = evaluations.map((item) => item.cutoffResults[cutoff]?.score ?? 0);
    const allMrr = evaluations.map((item) => item.cutoffResults[cutoff]?.mrr ?? 0);
    const byCategory = new Map<string, number[]>();
    const mrrByCategory = new Map<string, number[]>();
    for (const item of evaluations) {
      const score = item.cutoffResults[cutoff]?.score ?? 0;
      const mrr = item.cutoffResults[cutoff]?.mrr ?? 0;
      byCategory.set(item.categoryName, [...(byCategory.get(item.categoryName) ?? []), score]);
      mrrByCategory.set(item.categoryName, [...(mrrByCategory.get(item.categoryName) ?? []), mrr]);
    }

    const categoryMetrics: Record<string, GroupMetrics> = {};
    for (const [category, scores] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      categoryMetrics[category] = toGroupMetrics(category, scores, mrrByCategory.get(category) ?? []);
    }
    output[cutoff] = {
      cutoff,
      overall: toGroupMetrics("overall", allScores, allMrr),
      byCategory: categoryMetrics,
    };
  }
  return output;
}

function toGroupMetrics(groupName: string, scores: readonly number[], mrrValues: readonly number[]): GroupMetrics {
  const total = scores.length;
  const correct = scores.filter((score) => score >= 0.5).length;
  return {
    groupName,
    total,
    correct,
    accuracy: total === 0 ? 0 : (correct / total) * 100,
    avgScore: total === 0 ? 0 : (scores.reduce((sum, score) => sum + score, 0) / total) * 100,
    mrr: mrrValues.length === 0 ? 0 : mrrValues.reduce((sum, value) => sum + value, 0) / mrrValues.length,
  };
}
