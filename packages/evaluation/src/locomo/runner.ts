import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { cutoffLabel } from "../common/cutoffs.js";
import { computeMetricsByCutoff } from "../common/metrics.js";
import { writeBenchmarkReport } from "../common/report.js";
import type { BenchmarkResult, CutoffEvaluation, EvaluationItem, RetrievalResultItem } from "../common/schema.js";
import { loadOrDownloadLocomoDataset, getQuestionItems, LOCOMO_SCORING_CATEGORIES, sourceRefDiaId } from "./dataset.js";
import {
  AgentEngramHybridBackend,
  AgentEngramTypedFormationBackend,
  AgentEngramTypedRuntimeBackend,
  RawTranscriptFtsBackend,
  type LocomoBenchmarkBackend,
} from "./backends.js";

export interface LocomoRunOptions {
  /** Stable label used in report directory names. */
  readonly projectName: string;
  readonly datasetPath?: string;
  readonly datasetDir: string;
  readonly outputDir: string;
  readonly workDir: string;
  readonly backend: "raw-transcript-fts" | "agentengram-hybrid" | "agentengram-typed-formation" | "agentengram-typed-runtime";
  readonly conversations: readonly number[];
  readonly categories: readonly number[];
  readonly topK: number;
  readonly cutoffs: readonly number[];
  readonly maxQuestions?: number;
  readonly predictOnly: boolean;
  readonly reset: boolean;
  readonly runId?: string;
}

/** Runs predict-only LoCoMo retrieval evaluation against one benchmark backend. */
export async function runLocomoEvaluation(options: LocomoRunOptions): Promise<{
  readonly result: BenchmarkResult;
  readonly outputDir: string;
}> {
  const runId = options.runId ?? randomUUID().replace(/-/g, "").slice(0, 8);
  const dataset = await loadOrDownloadLocomoDataset({
    ...(options.datasetPath === undefined ? {} : { datasetPath: options.datasetPath }),
    datasetDir: options.datasetDir,
  });
  const backend = createBackend(options);
  try {
    const evaluations: EvaluationItem[] = [];
    for (const conversationIndex of options.conversations) {
      const sample = dataset.samples[conversationIndex];
      if (!sample) continue;
      await backend.ingest(sample, conversationIndex);
      const questions = getQuestionItems(sample, conversationIndex, options.categories, options.maxQuestions);
      for (const question of questions) {
        const startedAt = performance.now();
        const results = await backend.search(conversationIndex, question.question, options.topK);
        const latencyMs = performance.now() - startedAt;
        // LoCoMo scoring here is retrieval-only: a hit means a retrieved memory
        // cites at least one gold dia_id within the cutoff.
        evaluations.push(toEvaluationItem(question, results, latencyMs, options.cutoffs));
      }
    }

    const cutoffLabels = options.cutoffs.map(cutoffLabel);
    const result: BenchmarkResult = {
      schemaVersion: "agentengram.eval.v1",
      metadata: {
        benchmark: "locomo",
        projectName: options.projectName,
        runId,
        timestamp: new Date().toISOString(),
        backend: backend.name,
        topK: options.topK,
        topKCutoffs: cutoffLabels,
        totalQuestions: evaluations.length,
        predictOnly: options.predictOnly,
        config: {
          datasetPath: dataset.path,
          conversations: options.conversations,
          categories: options.categories,
          maxQuestions: options.maxQuestions ?? null,
          llm: {
            formation: false,
            answer: false,
            judge: false,
          },
        },
      },
      metricsByCutoff: computeMetricsByCutoff(evaluations, cutoffLabels),
      evaluations,
    };
    const runOutputDir = join(options.outputDir, `locomo_${options.projectName}_${runId}_${backend.name}`);
    await writeBenchmarkReport(runOutputDir, result);
    return { result, outputDir: runOutputDir };
  } finally {
    await backend.close();
  }
}

export function defaultLocomoRunOptions(projectName: string): LocomoRunOptions {
  return {
    projectName,
    datasetDir: "datasets/locomo",
    outputDir: "reports/locomo",
    workDir: ".agentengram-eval/locomo",
    backend: "agentengram-hybrid",
    conversations: [...Array.from({ length: 10 }, (_, index) => index)],
    categories: [...LOCOMO_SCORING_CATEGORIES],
    topK: 200,
    cutoffs: [10, 20, 50, 200],
    predictOnly: true,
    reset: true,
  };
}

function createBackend(options: LocomoRunOptions): LocomoBenchmarkBackend {
  if (options.backend === "raw-transcript-fts") return new RawTranscriptFtsBackend();
  if (options.backend === "agentengram-typed-formation") {
    return new AgentEngramTypedFormationBackend({ homeDir: join(options.workDir, options.projectName), reset: options.reset });
  }
  if (options.backend === "agentengram-typed-runtime") {
    return new AgentEngramTypedRuntimeBackend({ homeDir: join(options.workDir, options.projectName), reset: options.reset });
  }
  return new AgentEngramHybridBackend({ homeDir: join(options.workDir, options.projectName), reset: options.reset });
}

function toEvaluationItem(
  question: {
    readonly id: string;
    readonly category: number;
    readonly categoryName: string;
    readonly question: string;
    readonly answer: string;
    readonly evidence: readonly string[];
    readonly conversationIndex: number;
    readonly questionIndex: number;
  },
  results: readonly RetrievalResultItem[],
  latencyMs: number,
  cutoffs: readonly number[],
): EvaluationItem {
  const cutoffResults: Record<string, CutoffEvaluation> = {};
  for (const cutoff of cutoffs) {
    const sliced = results.slice(0, cutoff);
    const rank = firstEvidenceRank(sliced, question.evidence);
    const hit = rank !== undefined;
    cutoffResults[cutoffLabel(cutoff)] = {
      cutoff: cutoffLabel(cutoff),
      cutoffValue: cutoff,
      memoriesEvaluated: sliced.length,
      evidenceHit: hit,
      ...(rank === undefined ? {} : { evidenceHitRank: rank }),
      mrr: rank === undefined ? 0 : 1 / rank,
      score: hit ? 1 : 0,
      status: "retrieval-only",
    };
  }
  return {
    id: question.id,
    group: question.categoryName,
    category: question.category,
    categoryName: question.categoryName,
    question: question.question,
    groundTruth: question.answer,
    evidence: question.evidence,
    retrieval: {
      searchQuery: question.question,
      searchResults: results,
      searchLatencyMs: Math.round(latencyMs * 10) / 10,
      totalResults: results.length,
    },
    cutoffResults,
    extras: {
      conversationIndex: question.conversationIndex,
      questionIndex: question.questionIndex,
    },
  };
}

function firstEvidenceRank(results: readonly RetrievalResultItem[], evidence: readonly string[]): number | undefined {
  const evidenceSet = new Set(evidence);
  if (evidenceSet.size === 0) return undefined;
  for (const [index, result] of results.entries()) {
    // Source refs are the evaluation contract: backends can store raw turns,
    // episode summaries, or typed memories as long as they preserve dia_id refs.
    if (result.sourceRefs.some((ref) => {
      const diaId = sourceRefDiaId(ref);
      return diaId !== undefined && evidenceSet.has(diaId);
    })) {
      return index + 1;
    }
  }
  return undefined;
}
