import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LLMClient,
  LocalAgentEngramRuntime,
  loadAgentEngramConfig,
  resolveProjectIdentity,
  type AgentEngramProviderConfig,
  type LLMChatClient,
} from "@agentengram/engine";
import { acquireCodexWorkerLease } from "./worker-lock.js";

/** Adapter-owned process launch request emitted by a producer hook. */
export interface CodexWorkerLaunchRequest {
  readonly cwd: string;
  readonly homeDir: string;
}

/** Test seam and host integration contract for waking a Codex sidecar. */
export type CodexWorkerLauncher = (request: CodexWorkerLaunchRequest) => void | Promise<void>;

/** Starts a detached worker; the worker lease turns concurrent wakes into one effective runner. */
export const launchCodexWorker: CodexWorkerLauncher = (request) => {
  const workerPath = resolveWorkerPath();
  const child = spawn(process.execPath, [workerPath], {
    cwd: request.cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AGENTENGRAM_HOME: request.homeDir },
  });
  child.unref();
};

/** Resolves published dist output and the source-test layout without a shell wrapper. */
function resolveWorkerPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const adjacent = join(moduleDirectory, "worker-cli.js");
  if (existsSync(adjacent)) return adjacent;
  const builtFromSource = join(moduleDirectory, "..", "dist", "worker-cli.js");
  if (existsSync(builtFromSource)) return builtFromSource;
  throw new Error("Codex worker-cli.js is missing; build @agentengram/adapter-codex before running hooks");
}

export interface RunCodexWorkerOptions {
  readonly cwd: string;
  readonly homeDir: string;
  readonly llmClient?: LLMChatClient;
  readonly idleTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Drains one project's durable queue until it has remained idle. This runner is
 * intentionally short lived: command hooks can wake it without requiring a
 * permanently installed daemon or a concurrently running MCP server.
 */
export async function runCodexWorker(options: RunCodexWorkerOptions): Promise<"completed" | "already-running" | "disabled"> {
  const project = await resolveProjectIdentity(options.cwd);
  const installed = await loadAgentEngramConfig({ cwd: options.cwd, homeDir: options.homeDir });
  const lease = await acquireCodexWorkerLease(options.homeDir, project.projectId);
  if (!lease) return "already-running";
  const formationPolicy = installed.config.adapters?.codex?.models?.formation ?? installed.config.models?.formation;
  const client = options.llmClient
    ?? (formationPolicy?.strategy === "disabled" ? undefined : defaultWorkerLLMClient(installed.config.provider));
  if (!client) {
    await lease.release();
    return "disabled";
  }
  const runtime = await LocalAgentEngramRuntime.create({
    homeDir: options.homeDir,
    projectId: project.projectId,
    contextMode: "enhance",
    llmClient: client,
    workerExecutionMode: "external",
  });
  const idleTimeoutMs = Math.max(50, options.idleTimeoutMs ?? 30_000);
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 250);
  let idleSince = Date.now();
  try {
    while (!options.signal?.aborted) {
      const processed = await runtime.runReadyBackgroundJobs();
      const active = runtime.listBackgroundJobs().some((job) => job.status === "pending" || job.status === "processing");
      if (processed > 0 || active) idleSince = Date.now();
      if (!active && Date.now() - idleSince >= idleTimeoutMs) break;
      await delay(pollIntervalMs, options.signal);
    }
    return "completed";
  } finally {
    await runtime.close();
    await lease.release();
  }
}

/** Codex cannot expose its active inference client, so Formation uses a configured provider. */
function defaultWorkerLLMClient(provider: AgentEngramProviderConfig = {}): LLMChatClient | undefined {
  if (process.env.AGENTENGRAM_CODEX_FORMATION === "0") return undefined;
  const apiKey = process.env[provider.apiKeyEnv ?? "DASHSCOPE_API_KEY"];
  if (!apiKey) return undefined;
  const baseUrl = provider.baseUrl ?? process.env.QWEN_BASE_URL;
  const model = provider.model ?? process.env.QWEN_MODEL;
  return new LLMClient({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
  });
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      finish();
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
