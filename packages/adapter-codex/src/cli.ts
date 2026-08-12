#!/usr/bin/env node
import { createCodexHookHandler } from "./hook-runtime.js";
import type { CodexHookInput } from "./types.js";

const handler = createCodexHookHandler();

try {
  const input = JSON.parse(await readStdin()) as CodexHookInput;
  const output = await handler(input);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  // Codex command hooks are fail-open. Never print diagnostics to stdout,
  // because plain stdout is interpreted as model-visible additional context.
  process.stderr.write(`[AgentEngram Codex hook] ${error instanceof Error ? error.message : String(error)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
