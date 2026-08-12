import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runLocomoEvaluation } from "./runner.js";

describe("LoCoMo evaluation harness", () => {
  it("runs predict-only evidence recall with standard category metrics", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-locomo-"));
    try {
      const datasetPath = join(root, "locomo10.json");
      await writeFile(datasetPath, JSON.stringify(fixtureDataset()), "utf8");
      const { result } = await runLocomoEvaluation({
        projectName: "fixture",
        datasetPath,
        datasetDir: join(root, "datasets"),
        outputDir: join(root, "reports"),
        workDir: join(root, "work"),
        backend: "raw-transcript-fts",
        conversations: [0],
        categories: [1, 2, 3, 4],
        topK: 20,
        cutoffs: [1, 5, 20],
        predictOnly: true,
        reset: true,
      });
      expect(result.metadata.totalQuestions).toBe(4);
      expect(result.metricsByCutoff.top_1?.byCategory["single-hop"]?.total).toBe(1);
      expect(result.metricsByCutoff.top_5?.byCategory["multi-hop"]?.total).toBe(1);
      expect(result.metricsByCutoff.top_20?.byCategory["open-domain"]?.total).toBe(1);
      expect(result.metricsByCutoff.top_20?.byCategory.temporal?.total).toBe(1);
      expect(result.evaluations[0]?.cutoffResults.top_20?.status).toBe("retrieval-only");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs typed AgentEngram formation with standard category metrics", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-locomo-typed-"));
    try {
      const datasetPath = join(root, "locomo10.json");
      await writeFile(datasetPath, JSON.stringify(fixtureDataset()), "utf8");
      const { result } = await runLocomoEvaluation({
        projectName: "fixture-typed",
        datasetPath,
        datasetDir: join(root, "datasets"),
        outputDir: join(root, "reports"),
        workDir: join(root, "work"),
        backend: "agentengram-typed-formation",
        conversations: [0],
        categories: [1, 2, 3, 4],
        topK: 20,
        cutoffs: [1, 5, 20],
        predictOnly: true,
        reset: true,
      });
      expect(result.metadata.backend).toBe("agentengram-typed-formation");
      expect(result.metadata.totalQuestions).toBe(4);
      expect(result.metricsByCutoff.top_20?.byCategory["single-hop"]?.total).toBe(1);
      expect(result.metricsByCutoff.top_20?.byCategory["multi-hop"]?.total).toBe(1);
      expect(result.metricsByCutoff.top_20?.byCategory["open-domain"]?.total).toBe(1);
      expect(result.metricsByCutoff.top_20?.byCategory.temporal?.total).toBe(1);
      expect(result.evaluations.some((item) => item.retrieval.searchResults.some((memory) => memory.metadata.memoryClass === "factual"))).toBe(true);
      expect(result.evaluations.some((item) => item.retrieval.searchResults.some((memory) =>
        memory.metadata.memoryClass === "episodic" && memory.sourceRefs.length > 1,
      ))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs typed AgentEngram runtime recall with standard category metrics", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-locomo-runtime-"));
    try {
      const datasetPath = join(root, "locomo10.json");
      await writeFile(datasetPath, JSON.stringify(fixtureDataset()), "utf8");
      const { result } = await runLocomoEvaluation({
        projectName: "fixture-runtime",
        datasetPath,
        datasetDir: join(root, "datasets"),
        outputDir: join(root, "reports"),
        workDir: join(root, "work"),
        backend: "agentengram-typed-runtime",
        conversations: [0],
        categories: [1, 2, 3, 4],
        topK: 20,
        cutoffs: [1, 5, 20],
        predictOnly: true,
        reset: true,
      });
      expect(result.metadata.backend).toBe("agentengram-typed-runtime");
      expect(result.metadata.totalQuestions).toBe(4);
      expect(result.metricsByCutoff.top_20?.byCategory["single-hop"]?.total).toBe(1);
      expect(result.evaluations.some((item) => item.retrieval.searchResults.some((memory) =>
        memory.metadata.backend === "agentengram-typed-runtime",
      ))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fixtureDataset(): unknown {
  return [
    {
      conversation: {
        speaker_a: "Alice",
        speaker_b: "Bob",
        session_1_date_time: "1:56 pm on 8 May, 2023",
        session_1: [
          { dia_id: "D1:1", speaker: "Alice", text: "I adopted a corgi named Pixel." },
          { dia_id: "D1:2", speaker: "Bob", text: "Pixel loves agility training." },
          { dia_id: "D1:3", speaker: "Alice", text: "The robotics meetup happens every Thursday." },
          { dia_id: "D1:4", speaker: "Bob", text: "Corgis are usually energetic herding dogs." },
        ],
      },
      qa: [
        { category: 4, question: "What is Alice's dog named?", answer: "Pixel", evidence: ["D1:1"] },
        { category: 1, question: "What activity does Alice's corgi enjoy?", answer: "agility training", evidence: ["D1:1", "D1:2"] },
        { category: 2, question: "When is the robotics meetup?", answer: "Thursday", evidence: ["D1:3"] },
        { category: 3, question: "Are corgis energetic?", answer: "yes", evidence: ["D1:4"] },
      ],
      session_summary: {
        session_1_summary: "Alice adopted a corgi named Pixel. Pixel loves agility training. The robotics meetup happens every Thursday. Corgis are energetic herding dogs.",
      },
      event_summary: {
        events_session_1: {
          Alice: ["Alice adopted Pixel and discussed the robotics meetup."],
          Bob: ["Bob said Pixel loves agility training and corgis are energetic."],
          date: "8 May, 2023",
        },
      },
    },
  ];
}
