import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LLMClient,
  LocalAgentEngramRuntime,
  type NormalizedTranscriptEntry,
} from "@agentengram/engine";

const ONLINE_ENABLED = process.env.AGENTENGRAM_ONLINE_TESTS === "1";
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const QWEN_BASE_URL = process.env.QWEN_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_MODEL = process.env.QWEN_MODEL ?? "qwen-plus";

const describeOnline = ONLINE_ENABLED && DASHSCOPE_API_KEY ? describe : describe.skip;
const runtimes: LocalAgentEngramRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describeOnline("pi long-term formation with DashScope Qwen", () => {
  it("forms episodic and derived memory from transcript Cells and recalls it next turn", async () => {
    const homeDir = await temporaryDirectory("agentengram-online-formation-");
    const client = new LLMClient({
      baseUrl: QWEN_BASE_URL,
      apiKey: DASHSCOPE_API_KEY!,
      model: QWEN_MODEL,
      temperature: 0,
    });
    const runtime = await LocalAgentEngramRuntime.create({
      homeDir,
      projectId: "online-project",
      llmClient: client,
    });
    runtimes.push(runtime);

    await runtime.transcripts.appendNormalized("online-session", entry(
      "pi-entry-user",
      "user",
      "Durable project decision: AgentEngram V1 uses Markdown plus SQLite FTS5 only. Do not add embeddings in V1.",
    ));
    await runtime.transcripts.appendNormalized("online-session", entry(
      "pi-entry-assistant",
      "assistant",
      "Confirmed. Future V1 implementation must persist Markdown truth and use FTS5 retrieval without embeddings.",
    ));
    await expect(runtime.flushCellFormation({ sessionId: "online-session", threadId: "online-thread" }))
      .resolves.toMatchObject({ status: "completed", closedCells: 1, pendingCells: 0 });

    const search = await runtime.longTerm.search({
      query: "FTS5 embeddings deferred",
      projectId: "online-project",
      maxResults: 5,
    });

    expect(search.memories.some(({ record }) => record.memoryClass === "episodic")).toBe(true);
    expect(search.memories.some(({ record }) => record.memoryClass !== "episodic")).toBe(true);
    expect(JSON.stringify(search.memories)).toContain("FTS5");
    expect(JSON.stringify(search.memories)).toContain("agentengram://transcript/online-session/online-thread/pi-entry-user");
    expect(JSON.stringify(search.memories)).toContain("agentengram://transcript/online-session/online-thread/pi-entry-assistant");
  }, 90_000);
});

/** Builds normalized Pi evidence without bypassing the portable transcript API. */
function entry(id: string, role: string, text: string): NormalizedTranscriptEntry {
  return {
    schemaVersion: 1,
    id,
    sessionId: "online-session",
    threadId: "online-thread",
    sourceRef: `agentengram://transcript/online-session/online-thread/${id}`,
    kind: "message",
    role,
    text,
    contentHash: `online-${id}`,
    createdAt: new Date().toISOString(),
  };
}

/** Creates a temporary AgentEngram home and tracks it for test cleanup. */
async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
