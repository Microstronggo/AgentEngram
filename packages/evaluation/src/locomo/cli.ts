#!/usr/bin/env node
import { parseCutoffs } from "../common/cutoffs.js";
import { defaultLocomoRunOptions, runLocomoEvaluation, type LocomoRunOptions } from "./runner.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectName = stringArg(args, "project-name") ?? "agentengram-locomo";
  const defaults = defaultLocomoRunOptions(projectName);
  const backend = (stringArg(args, "backend") ?? defaults.backend) as LocomoRunOptions["backend"];
  if (backend !== "raw-transcript-fts" &&
    backend !== "agentengram-hybrid" &&
    backend !== "agentengram-typed-formation" &&
    backend !== "agentengram-typed-runtime") {
    throw new Error(`unsupported --backend ${backend}`);
  }
  const predictOnly = !booleanArg(args, "answer") && !booleanArg(args, "judge");
  if (!predictOnly) {
    throw new Error("answer/judge LLM evaluation is not implemented yet; run with predict-only retrieval mode");
  }
  const datasetPath = stringArg(args, "dataset-path");
  const maxQuestions = numberArg(args, "max-questions");
  const runId = stringArg(args, "run-id");
  const options: LocomoRunOptions = {
    ...defaults,
    backend,
    predictOnly,
    conversations: parseNumberList(stringArg(args, "conversations") ?? defaults.conversations.join(",")),
    categories: parseNumberList(stringArg(args, "categories") ?? defaults.categories.join(",")),
    cutoffs: parseCutoffs(stringArg(args, "top-k-cutoffs") ?? defaults.cutoffs.join(",")),
    topK: numberArg(args, "top-k") ?? defaults.topK,
    reset: !booleanArg(args, "no-reset"),
    ...(datasetPath === undefined ? {} : { datasetPath }),
    datasetDir: stringArg(args, "dataset-dir") ?? defaults.datasetDir,
    outputDir: stringArg(args, "output-dir") ?? defaults.outputDir,
    workDir: stringArg(args, "work-dir") ?? defaults.workDir,
    ...(maxQuestions === undefined ? {} : { maxQuestions }),
    ...(runId === undefined ? {} : { runId }),
  };

  const { result, outputDir } = await runLocomoEvaluation(options);
  console.log(`LoCoMo ${result.metadata.backend} complete: ${result.metadata.totalQuestions} questions`);
  console.log(`Output: ${outputDir}`);
  for (const cutoff of result.metadata.topKCutoffs) {
    const metrics = result.metricsByCutoff[cutoff];
    if (!metrics) continue;
    console.log(`${cutoff}: ${metrics.overall.correct}/${metrics.overall.total} (${metrics.overall.accuracy.toFixed(1)}%)`);
    for (const [category, group] of Object.entries(metrics.byCategory).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${category}: ${group.correct}/${group.total} (${group.accuracy.toFixed(1)}%)`);
    }
  }
}

function parseArgs(values: readonly string[]): Map<string, string | true> {
  const output = new Map<string, string | true>();
  for (let index = 0; index < values.length; index++) {
    const current = values[index];
    if (!current?.startsWith("--")) continue;
    const key = current.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      output.set(key, next);
      index++;
    } else {
      output.set(key, true);
    }
  }
  return output;
}

function stringArg(args: ReadonlyMap<string, string | true>, key: string): string | undefined {
  const value = args.get(key);
  return typeof value === "string" ? value : undefined;
}

function numberArg(args: ReadonlyMap<string, string | true>, key: string): number | undefined {
  const value = stringArg(args, key);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanArg(args: ReadonlyMap<string, string | true>, key: string): boolean {
  return args.has(key);
}

function parseNumberList(value: string): readonly number[] {
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((part) => Number.isFinite(part));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
