import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LLMClient, LLMCompactSummarizer, LocalAgentEngramRuntime } from "@agentengram/engine";
import { createRuntimeEngineFacade } from "../../src/runtime-engine-facade.js";

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

describeOnline("pi managed-context compact with DashScope Qwen", () => {
  it("returns AgentEngram summary and Pi-compatible compaction metadata", async () => {
    const homeDir = await temporaryDirectory("agentengram-online-compact-");
    const client = new LLMClient({
      baseUrl: QWEN_BASE_URL,
      apiKey: DASHSCOPE_API_KEY!,
      model: QWEN_MODEL,
      temperature: 0,
    });
    const runtime = await LocalAgentEngramRuntime.create({
      homeDir,
      projectId: "online-project",
      summarizer: new LLMCompactSummarizer({ client }),
    });
    runtimes.push(runtime);

    const result = await createRuntimeEngineFacade(runtime).compact({
      mode: "managed-context",
      cwd: process.env.PI_MONO_PATH ?? process.cwd(),
      sessionId: "online-session",
      threadId: "online-thread",
      preparation: {
        firstKeptEntryId: "pi-entry-3",
        settings: { keepRecentTokens: 4 },
      },
      branchEntries: [
        { id: "pi-entry-1", type: "message" },
        { id: "pi-entry-2", type: "message" },
        { id: "pi-entry-3", type: "message" },
      ],
      canonicalMessages: [
        piMessage("m1", "User goal: make pi-mono use AgentEngram managed-context by default."),
        piMessage("m2", "Decision: long-term memory uses Markdown plus FTS5 for V1."),
        piMessage("m3", "Recent request: verify that compact returns summary plus recent messages."),
      ],
    });

    expect(result?.summary).toContain("AgentEngram");
    expect(result?.firstKeptEntryId).toBe("pi-entry-3");
    expect(result?.details?.agentengram.summaryModel).toBeTruthy();
    expect(result?.tokensBefore).toBeGreaterThan(0);
  }, 60_000);
});

/** Creates a minimal Pi-like user message for the adapter bridge. */
function piMessage(id: string, text: string) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.parse("2026-06-24T00:00:00.000Z"),
  };
}

/** Creates a temporary AgentEngram home and tracks it for test cleanup. */
async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
