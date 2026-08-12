import { describe, expect, it } from "vitest";
import { CellBoundaryDetector } from "../memory/long-term/formation/cell-boundary.js";
import type { MemoryRecord } from "../memory/long-term/records/memory-record.js";
import { LLMBoundaryDecisionModel } from "./llm-boundary-decision-model.js";
import { LLMDerivedMemoryExtractor, LLMEpisodeCandidateExtractor } from "./llm-cell-memory-extractors.js";
import { LLMClient } from "./llm-client.js";

const ONLINE_ENABLED = process.env.AGENTENGRAM_ONLINE_TESTS === "1";
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const QWEN_BASE_URL = process.env.QWEN_BASE_URL;
const QWEN_MODEL = process.env.QWEN_MODEL;
const describeOnline = ONLINE_ENABLED && DASHSCOPE_API_KEY ? describe : describe.skip;

/** Real Qwen smoke coverage; default test runs skip it to avoid implicit API cost. */
describeOnline("Engine LLM Cell formation with Qwen", () => {
  it("detects a Cell, extracts an episode, and derives typed child memories", async () => {
    const client = new LLMClient({
      apiKey: DASHSCOPE_API_KEY!,
      ...(QWEN_BASE_URL ? { baseUrl: QWEN_BASE_URL } : {}),
      ...(QWEN_MODEL ? { model: QWEN_MODEL } : {}),
      maxTokens: 1_500,
    });
    const sourceRefs = ["pi:online-session:user-1", "pi:online-session:assistant-1"];
    const cellText = [
      "user: AgentEngram uses Markdown as durable truth and FTS5 as its V1 search projection.",
      "user: Always ask the user before creating a git commit.",
      "assistant: The validation finished successfully and the rule was recorded.",
    ].join("\n");

    const boundary = await new CellBoundaryDetector({
      model: new LLMBoundaryDecisionModel({ client }),
    }).detect({
      entries: [
        { id: "user-1", role: "user", text: cellText, sourceRef: sourceRefs[0] },
        { id: "assistant-1", role: "assistant", text: "Validation complete.", sourceRef: sourceRefs[1] },
      ],
      projectId: "agentengram-online",
      isFinal: true,
    });
    expect(boundary.cells.length).toBeGreaterThan(0);
    expect(boundary.tail).toEqual([]);

    const observation = {
      text: boundary.cells.map((cell) => cell.text).join("\n"),
      sourceRefs,
      projectId: "agentengram-online",
    };
    const episodes = await new LLMEpisodeCandidateExtractor({ client }).extract(observation);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.memoryClass).toBe("episodic");

    const episode: MemoryRecord = {
      id: "online-episode-1",
      schemaVersion: 1,
      name: episodes[0]!.name,
      description: episodes[0]!.description,
      content: episodes[0]!.content,
      type: episodes[0]!.type,
      scope: episodes[0]!.scope,
      memoryClass: "episodic",
      projectId: "agentengram-online",
      tags: [],
      sourceRefs,
      status: "active",
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
    };
    const derived = await new LLMDerivedMemoryExtractor({ client }).extract({ observation, episode });
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((candidate) => candidate.memoryClass !== "episodic")).toBe(true);
    expect(derived.some((candidate) => candidate.memoryClass === "procedural")).toBe(true);
  }, 60_000);
});
