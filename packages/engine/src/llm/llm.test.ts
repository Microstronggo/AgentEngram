import { describe, expect, it } from "vitest";
import { CellBoundaryDetector } from "../memory/long-term/formation/cell-boundary.js";
import { LLMBoundaryDecisionModel } from "./llm-boundary-decision-model.js";
import { LLMDerivedMemoryExtractor, LLMEpisodeCandidateExtractor } from "./llm-cell-memory-extractors.js";
import { LLMClient } from "./llm-client.js";
import { LLMCompactSummarizer } from "./llm-compact-summarizer.js";
import { LLMMemoryCandidateExtractor } from "./llm-memory-candidate-extractor.js";

describe("LLMClient", () => {
  it("defaults to the DashScope Qwen endpoint and qwen-plus model", async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
    const client = new LLMClient({
      apiKey: "test-key",
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 3 } });
      },
    });

    await expect(client.chat([{ role: "user", content: "hello" }])).resolves.toEqual({
      content: "ok",
      model: "qwen-plus",
      usage: { total_tokens: 3 },
    });
    expect(requests[0]).toMatchObject({
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      body: { model: "qwen-plus", messages: [{ role: "user", content: "hello" }] },
    });
  });

  it("allows endpoint and model overrides", async () => {
    let requestedUrl = "";
    const client = new LLMClient({
      apiKey: "test-key",
      baseUrl: "https://llm.example.test/v1/",
      model: "custom-model",
      fetch: async (url) => {
        requestedUrl = String(url);
        return jsonResponse({ model: "custom-model", choices: [{ message: { content: "ok" } }] });
      },
    });

    const result = await client.chat([{ role: "user", content: "hello" }]);
    expect(result.model).toBe("custom-model");
    expect(requestedUrl).toBe("https://llm.example.test/v1/chat/completions");
  });
});

describe("LLMCompactSummarizer", () => {
  it("returns summary text, model and usage", async () => {
    const summarizer = new LLMCompactSummarizer({
      client: fakeClient({ model: "qwen-test", choices: [{ message: { content: " summary " } }], usage: { total_tokens: 8 } }),
    });

    const summary = await summarizer.summarize({
      instructions: ["Keep decisions."],
      messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "remember this decision" }] }],
    });

    expect(summary).toEqual({ text: "summary", model: "qwen-test", usage: { total_tokens: 8 } });
  });
});

describe("LLMMemoryCandidateExtractor", () => {
  it("parses candidate arrays and structured metadata", async () => {
    const extractor = new LLMMemoryCandidateExtractor({
      client: fakeClient({
        choices: [{ message: { content: JSON.stringify([{ name: "Managed context default", description: "Default mode", type: "project", scope: "project", kind: "decision", memoryClass: "factual", content: "Use managed-context.", confidence: 0.9, entities: ["pi-mono"], relations: [{ subject: "AgentEngram", predicate: "manages", object: "context" }], parentMemoryIds: ["episode-1"] }]) } }],
      }),
    });

    await expect(extractor.extract({ text: "turn", sourceRefs: ["turn:1"], projectId: "project-a" })).resolves.toEqual([
      {
        name: "Managed context default",
        description: "Default mode",
        type: "project",
        scope: "project",
        kind: "decision",
        memoryClass: "factual",
        content: "Use managed-context.",
        confidence: 0.9,
        projectId: "project-a",
        entities: ["pi-mono"],
        relations: [{ subject: "AgentEngram", predicate: "manages", object: "context" }],
        parentMemoryIds: ["episode-1"],
      },
    ]);
  });

  it("fails closed on malformed JSON and clamps unsupported schema values", async () => {
    const malformed = new LLMMemoryCandidateExtractor({ client: fakeClient({ choices: [{ message: { content: "not json" } }] }) });
    await expect(malformed.extract({ text: "turn", sourceRefs: [] })).resolves.toEqual([]);

    const clamped = new LLMMemoryCandidateExtractor({
      client: fakeClient({ choices: [{ message: { content: JSON.stringify({ candidates: [{ name: "Valid", description: "External labels", type: "todo", scope: "organization", content: "Use supported schema.", memoryClass: "unknown" }] }) } }] }),
      defaultMemoryClass: "factual",
    });
    await expect(clamped.extract({ text: "turn", sourceRefs: [] })).resolves.toEqual([
      { name: "Valid", description: "External labels", type: "project", scope: "project", content: "Use supported schema.", memoryClass: "factual" },
    ]);
  });
});

describe("LLMBoundaryDecisionModel", () => {
  it("composes with Engine CellBoundaryDetector and remaps hidden tool evidence", async () => {
    const requests: unknown[] = [];
    const client = new LLMClient({
      apiKey: "test-key",
      model: "qwen-test",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return jsonResponse({ choices: [{ message: { content: JSON.stringify({ boundaries: [1], should_wait: true }) } }] });
      },
    });
    const detector = new CellBoundaryDetector({
      model: new LLMBoundaryDecisionModel({ client }),
      idFactory: () => "cell-1",
    });

    const result = await detector.detect({
      entries: [
        { id: "tool-0", role: "tool", text: "Earlier hidden evidence", includeInBoundaryPrompt: false },
        { id: "user-1", role: "user", text: "Validate managed-context." },
        { id: "tool-1", role: "tool", text: "Tool evidence", includeInBoundaryPrompt: false },
        { id: "user-2", role: "user", text: "Now discuss LoCoMo." },
      ],
    });

    expect(result.cells[0]?.sourceEntryIds).toEqual(["tool-0", "user-1", "tool-1"]);
    expect(result.tail.map((entry) => entry.id)).toEqual(["user-2"]);
    expect(JSON.stringify(requests[0])).not.toContain("Tool evidence");
    expect(JSON.stringify(requests[0])).not.toContain("Earlier hidden evidence");
  });

  it("flushes the final tail even when the LLM asks to wait", async () => {
    const detector = new CellBoundaryDetector({
      model: new LLMBoundaryDecisionModel({
        client: fakeClient({ choices: [{ message: { content: JSON.stringify({ boundaries: [], should_wait: true }) } }] }),
      }),
      idFactory: () => "cell-final",
    });

    const result = await detector.detect({
      entries: [{ id: "user-1", role: "user", text: "Finalize this completed session." }],
      isFinal: true,
    });
    expect(result.cells[0]?.sourceEntryIds).toEqual(["user-1"]);
    expect(result.tail).toEqual([]);
  });
});

describe("LLM staged Cell memory extractors", () => {
  it("keeps episode extraction to one episodic candidate", async () => {
    const extractor = new LLMEpisodeCandidateExtractor({
      client: fakeClient({ choices: [{ message: { content: JSON.stringify([
        { name: "Episode", description: "Episode", content: "Validation completed.", type: "project", scope: "project", memoryClass: "episodic" },
        { name: "Fact", description: "Fact", content: "A child.", type: "project", scope: "project", memoryClass: "factual" },
      ]) } }] }),
    });

    await expect(extractor.extract({ text: "cell", sourceRefs: ["entry-1"] })).resolves.toEqual([
      { name: "Episode", description: "Episode", content: "Validation completed.", type: "project", scope: "project", kind: "insight", memoryClass: "episodic" },
    ]);
  });

  it("derives non-episodic candidates from a parent episode", async () => {
    const extractor = new LLMDerivedMemoryExtractor({
      client: fakeClient({ choices: [{ message: { content: JSON.stringify([
        { name: "Rule", description: "Rule", content: "Ask before commit.", type: "feedback", scope: "user", memoryClass: "procedural" },
        { name: "Episode", description: "Episode", content: "Filtered.", type: "project", scope: "project", memoryClass: "episodic" },
      ]) } }] }),
    });

    const result = await extractor.extract({
      observation: { text: "source cell", sourceRefs: ["entry-1"] },
      episode: {
        id: "episode-1", name: "Episode", description: "Episode", content: "Parent episode.", type: "project", scope: "project", tags: [], schemaVersion: 1, memoryClass: "episodic", sourceRefs: ["entry-1"], status: "active", createdAt: "2026-06-26T00:00:00.000Z", updatedAt: "2026-06-26T00:00:00.000Z",
      },
    });
    expect(result).toEqual([
      { name: "Rule", description: "Rule", content: "Ask before commit.", type: "feedback", scope: "user", memoryClass: "procedural" },
    ]);
  });
});

function fakeClient(payload: unknown): LLMClient {
  return new LLMClient({
    apiKey: "test-key",
    model: "qwen-test",
    fetch: async () => jsonResponse(payload),
  });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
