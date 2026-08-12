export interface BenchmarkMetadata {
  readonly benchmark: string;
  readonly projectName: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly backend: string;
  readonly topK: number;
  readonly topKCutoffs: readonly string[];
  readonly totalQuestions: number;
  readonly predictOnly: boolean;
  readonly answererModel?: string;
  readonly judgeModel?: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface RetrievalResultItem {
  readonly memory: string;
  readonly score: number;
  readonly createdAt?: string;
  readonly sourceRefs: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RetrievalData {
  readonly searchQuery: string;
  readonly searchResults: readonly RetrievalResultItem[];
  readonly searchLatencyMs: number;
  readonly totalResults: number;
}

export interface CutoffEvaluation {
  readonly cutoff: string;
  readonly cutoffValue: number;
  readonly memoriesEvaluated: number;
  readonly evidenceHit: boolean;
  readonly evidenceHitRank?: number;
  readonly mrr: number;
  readonly score: number;
  readonly generatedAnswer?: string;
  readonly judgment?: string;
  readonly reason?: string;
  readonly status: "retrieval-only" | "judged" | "skipped";
}

export interface EvaluationItem {
  readonly id: string;
  readonly group: string;
  readonly category: number;
  readonly categoryName: string;
  readonly question: string;
  readonly groundTruth: string;
  readonly evidence: readonly string[];
  readonly retrieval: RetrievalData;
  readonly cutoffResults: Readonly<Record<string, CutoffEvaluation>>;
  readonly extras: Readonly<Record<string, unknown>>;
}

export interface GroupMetrics {
  readonly groupName: string;
  readonly total: number;
  readonly correct: number;
  readonly accuracy: number;
  readonly avgScore: number;
  readonly mrr: number;
}

export interface CutoffMetrics {
  readonly cutoff: string;
  readonly overall: GroupMetrics;
  readonly byCategory: Readonly<Record<string, GroupMetrics>>;
}

export interface BenchmarkResult {
  readonly schemaVersion: "agentengram.eval.v1";
  readonly metadata: BenchmarkMetadata;
  readonly metricsByCutoff: Readonly<Record<string, CutoffMetrics>>;
  readonly evaluations: readonly EvaluationItem[];
}
