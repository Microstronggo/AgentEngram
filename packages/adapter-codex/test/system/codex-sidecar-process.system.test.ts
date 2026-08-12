import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMChatClient } from "@agentengram/engine";
import { createCodexHookHandler } from "../../src/hook-runtime.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeDirectoryEventually));
});

describe("Codex detached worker process", () => {
  it("drains a Hook-produced job through the configured provider wire protocol", async () => {
    const cwd = await temporaryDirectory("agentengram-codex-worker-process-project-");
    const homeDir = await temporaryDirectory("agentengram-codex-worker-process-home-");
    const rollout = join(cwd, "rollout.jsonl");
    await writeFile(rollout, [
      { timestamp: "2026-07-01T00:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-1" } },
      { timestamp: "2026-07-01T00:00:01.000Z", type: "response_item", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: "Always ask before committing code." }],
      } },
      { timestamp: "2026-07-01T00:00:02.000Z", type: "response_item", payload: {
        type: "message", role: "assistant", content: [{ type: "output_text", text: "I will request confirmation first." }],
      } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

    const provider = await startFakeProvider();
    const savedEnvironment = captureEnvironment([
      "AGENTENGRAM_HOME",
      "DASHSCOPE_API_KEY",
      "QWEN_BASE_URL",
      "QWEN_MODEL",
      "AGENTENGRAM_CODEX_WORKER_IDLE_MS",
      "AGENTENGRAM_CODEX_WORKER_POLL_MS",
    ]);
    try {
      Object.assign(process.env, {
        AGENTENGRAM_HOME: homeDir,
        DASHSCOPE_API_KEY: "test-key",
        QWEN_BASE_URL: provider.baseUrl,
        QWEN_MODEL: "fake-qwen",
        AGENTENGRAM_CODEX_WORKER_IDLE_MS: "50",
        AGENTENGRAM_CODEX_WORKER_POLL_MS: "5",
      });

      const handler = createCodexHookHandler({
        homeDir,
        workerExecutionMode: "sidecar",
        // Presence enables Formation, while the producer must never invoke it.
        // The default detached launcher starts dist/worker-cli.js with the HTTP provider.
        llmClient: new RejectingLLMClient(),
        failOpen: false,
      });
      const startedAt = Date.now();
      await handler({
        session_id: "session-process",
        turn_id: "turn-1",
        transcript_path: rollout,
        cwd,
        hook_event_name: "Stop",
        model: "gpt-test",
        permission_mode: "default",
        last_assistant_message: "I will request confirmation first.",
        stop_hook_active: false,
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await waitFor(() => provider.stages.length === 3, 10_000);
      expect(provider.stages).toEqual(["boundary", "episode", "derived"]);
    } finally {
      restoreEnvironment(savedEnvironment);
      await provider.close();
    }

    const recalled = await createCodexHookHandler({
      homeDir,
      formationEnabled: false,
      failOpen: false,
    })({
      session_id: "session-process",
      turn_id: "turn-2",
      transcript_path: rollout,
      cwd,
      hook_event_name: "UserPromptSubmit",
      model: "gpt-test",
      permission_mode: "default",
      prompt: "What should happen before committing code?",
    });
    expect(recalled?.hookSpecificOutput?.additionalContext).toMatch(/required confirmation before committing code/i);
  }, 15_000);
});

class RejectingLLMClient implements LLMChatClient {
  async chat(): Promise<never> {
    throw new Error("producer Hook must not invoke its injected LLM client");
  }
}

/** Allows the detached worker a brief window to release files after its durable write. */
async function removeDirectoryEventually(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && ["EBUSY", "ENOTEMPTY", "EPERM"].includes(String(error.code)))) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  await rm(directory, { recursive: true, force: true });
}

async function startFakeProvider(): Promise<{
  readonly baseUrl: string;
  readonly stages: string[];
  close(): Promise<void>;
}> {
  const stages: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      await respondToFormation(request, response, stages);
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake provider did not expose a TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stages,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function respondToFormation(
  request: IncomingMessage,
  response: ServerResponse,
  stages: string[],
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    messages?: readonly { readonly content?: string }[];
  };
  const system = body.messages?.[0]?.content ?? "";
  let content: string;
  if (system.includes("Cell boundary detector")) {
    stages.push("boundary");
    content = '{"boundaries":[],"should_wait":true}';
  } else if (system.includes("episodic memory extractor")) {
    stages.push("episode");
    content = JSON.stringify({ candidates: [{
      name: "Commit confirmation episode",
      description: "The user established a commit confirmation rule.",
      content: "The user required confirmation before committing code.",
      type: "project",
      scope: "project",
      memoryClass: "episodic",
      confidence: 0.98,
    }] });
  } else {
    stages.push("derived");
    content = JSON.stringify({ candidates: [{
      name: "Confirm before committing",
      description: "Safe commit procedure.",
      content: "Ask for confirmation before committing code.",
      type: "project",
      scope: "project",
      memoryClass: "procedural",
      kind: "convention",
      confidence: 0.99,
    }] });
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ model: "fake-qwen", choices: [{ message: { content } }] }));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("detached Codex worker did not complete before timeout");
}

function captureEnvironment(names: readonly string[]): ReadonlyMap<string, string | undefined> {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(saved: ReadonlyMap<string, string | undefined>): void {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
