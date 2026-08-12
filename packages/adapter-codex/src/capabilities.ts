import type { HostCapabilities } from "@agentengram/engine/adapter";

export type CodexIntegrationMode = "auto" | "enhance" | "managed-context";

/** Command hooks can inject context and observe compact, but cannot replace either. */
export const CODEX_CAPABILITIES: HostCapabilities = Object.freeze({
  contextHook: true,
  replaceContext: false,
  compactionHook: true,
  replaceCompaction: false,
  sessionLifecycle: true,
  threadLifecycle: true,
  // Codex offers tool hooks, but V1 intentionally does not install them on
  // every tool invocation because command-process startup would add latency.
  toolLifecycle: false,
  persistentCustomEntries: false,
  transcriptMode: "jsonl-rollout",
  canInvokeCurrentModel: false,
  runtimeLifetime: "command-hook",
  supportsSubagents: true,
  schemaVersion: "codex-command-hooks-v1",
});

/** Resolves install intent without pretending Codex transferred context ownership. */
export function resolveCodexMode(mode: CodexIntegrationMode = "auto"): "enhance" {
  if (mode === "managed-context") {
    throw new Error("Codex hooks cannot replace model context or compaction; managed-context is unavailable");
  }
  return "enhance";
}
