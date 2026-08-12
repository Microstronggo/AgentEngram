import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiCurrentModelLLMClient } from "../../src/pi-current-model-client.js";
import { LocalRuntimeEngineFacade } from "../../src/runtime-engine-facade.js";
import type { PiContext, PiModel } from "../../src/pi-types.js";

const ONLINE_ENABLED = process.env.AGENTENGRAM_ONLINE_TESTS === "1";
const API_KEY = process.env.DASHSCOPE_API_KEY;
const MODEL = process.env.QWEN_MODEL ?? "qwen-plus";
const BASE_URL = process.env.QWEN_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
const describeOnline = ONLINE_ENABLED && API_KEY ? describe : describe.skip;
const facades: LocalRuntimeEngineFacade[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(facades.splice(0).map((facade) => facade.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describeOnline("Pi host-current model bridge with DashScope Qwen", () => {
  it("uses Pi current-model auth for managed Compact instead of configured provider fallback", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-pi-current-online-"));
    directories.push(homeDir);
    const currentModel = new PiCurrentModelLLMClient();
    const facade = new LocalRuntimeEngineFacade({ homeDir, currentModelClient: currentModel, contextMode: "managed-context" });
    facades.push(facade);
    const context = piContext();
    facade.observeHostContext(context);

    const result = await facade.compact({
      mode: "managed-context",
      preparation: { firstKeptEntryId: "entry-3", settings: { keepRecentTokens: 8 } },
      branchEntries: [{ id: "entry-1" }, { id: "entry-2" }, { id: "entry-3" }],
      signal: new AbortController().signal,
      cwd: process.env.PI_MONO_PATH ?? process.cwd(),
      sessionId: "pi-current-online-session",
      threadId: "pi-current-online-thread",
      canonicalMessages: [
        message("m1", "AgentEngram owns managed context for this explicit Pi session."),
        message("m2", "Portable transcript remains the cross-framework source of truth."),
        message("m3", "Return a compact continuation summary and retain recent work."),
      ],
      model: context.model,
    });

    expect(result?.summary).toBeTruthy();
    expect(result?.firstKeptEntryId).toBe("entry-3");
    expect(currentModel.lastDecision()).toMatchObject({
      source: "host-current",
      requestedModel: `dashscope/${MODEL}`,
    });
  }, 90_000);
});

function piContext(): PiContext {
  const model: PiModel = {
    id: MODEL,
    name: MODEL,
    api: "openai-completions",
    provider: "dashscope",
    baseUrl: BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_096,
  };
  return {
    cwd: process.env.PI_MONO_PATH ?? process.cwd(),
    sessionManager: { getSessionFile: () => "/tmp/pi-current-online.jsonl" },
    model,
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: API_KEY! }) },
  };
}

function message(id: string, text: string) {
  return { id, role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}
