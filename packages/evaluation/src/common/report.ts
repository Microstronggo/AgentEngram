import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkResult, CutoffMetrics } from "./schema.js";

export async function writeBenchmarkReport(outputDir: string, result: BenchmarkResult): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(
    join(outputDir, "evaluations.jsonl"),
    result.evaluations.map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8",
  );
  await writeFile(join(outputDir, "metrics.json"), `${JSON.stringify(result.metricsByCutoff, null, 2)}\n`, "utf8");
  await writeFile(join(outputDir, "summary.md"), renderSummary(result), "utf8");
}

export function renderSummary(result: BenchmarkResult): string {
  const lines = [
    `# ${result.metadata.benchmark} evaluation`,
    "",
    `- project: ${result.metadata.projectName}`,
    `- run: ${result.metadata.runId}`,
    `- backend: ${result.metadata.backend}`,
    `- predictOnly: ${String(result.metadata.predictOnly)}`,
    `- questions: ${result.metadata.totalQuestions}`,
    `- topK: ${result.metadata.topK}`,
    "",
  ];
  for (const cutoff of result.metadata.topKCutoffs) {
    const metrics = result.metricsByCutoff[cutoff];
    if (!metrics) continue;
    lines.push(...renderCutoff(metrics), "");
  }
  return `${lines.join("\n")}\n`;
}

function renderCutoff(metrics: CutoffMetrics): string[] {
  const lines = [
    `## ${metrics.cutoff}`,
    "",
    "| Category | Correct | Total | Accuracy | Avg score | MRR |",
    "|---|---:|---:|---:|---:|---:|",
    row("overall", metrics.overall),
  ];
  for (const category of Object.keys(metrics.byCategory).sort()) {
    const group = metrics.byCategory[category];
    if (group) lines.push(row(category, group));
  }
  return lines;
}

function row(label: string, group: { readonly correct: number; readonly total: number; readonly accuracy: number; readonly avgScore: number; readonly mrr: number }): string {
  return `| ${label} | ${group.correct} | ${group.total} | ${group.accuracy.toFixed(1)}% | ${group.avgScore.toFixed(1)}% | ${group.mrr.toFixed(3)} |`;
}
