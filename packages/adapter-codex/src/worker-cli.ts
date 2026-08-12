#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { runCodexWorker } from "./worker-runner.js";

const controller = new AbortController();
const idleTimeoutMs = numberEnvironment("AGENTENGRAM_CODEX_WORKER_IDLE_MS");
const pollIntervalMs = numberEnvironment("AGENTENGRAM_CODEX_WORKER_POLL_MS");
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  await runCodexWorker({
    cwd: process.cwd(),
    homeDir: process.env.AGENTENGRAM_HOME ?? join(homedir(), ".agentengram"),
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    signal: controller.signal,
  });
} catch (error) {
  // A detached worker has no model-visible stdout. Keep diagnostics on stderr
  // for manual execution while command-hook launches intentionally ignore it.
  process.stderr.write(`[AgentEngram Codex worker] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function numberEnvironment(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
