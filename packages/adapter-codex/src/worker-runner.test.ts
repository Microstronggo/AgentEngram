import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMChatClient } from "@agentengram/engine";
import { runCodexWorker } from "./worker-runner.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Codex worker runner", () => {
  it("keeps one effective sidecar and exits after the configured idle window", async () => {
    const cwd = await temporaryDirectory("agentengram-codex-worker-project-");
    const homeDir = await temporaryDirectory("agentengram-codex-worker-home-");
    const startedAt = Date.now();
    const first = runCodexWorker({
      cwd,
      homeDir,
      llmClient: new UnusedLLMClient(),
      idleTimeoutMs: 80,
      pollIntervalMs: 5,
    });
    await waitForLease(homeDir);

    await expect(runCodexWorker({
      cwd,
      homeDir,
      llmClient: new UnusedLLMClient(),
      idleTimeoutMs: 80,
      pollIntervalMs: 5,
    })).resolves.toBe("already-running");
    await expect(first).resolves.toBe("completed");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
  });
});

class UnusedLLMClient implements LLMChatClient {
  async chat(): Promise<never> {
    throw new Error("an idle worker must not call the model");
  }
}

async function waitForLease(homeDir: string): Promise<void> {
  const directory = join(homeDir, "locks", "codex-workers");
  for (let attempt = 0; attempt < 100; attempt++) {
    const entries = await readdir(directory).catch(() => []);
    if (entries.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Codex worker lease was not created");
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
