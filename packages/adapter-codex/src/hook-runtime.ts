import { homedir } from "node:os";
import { join } from "node:path";
import {
  LLMClient,
  LLMCompactSummarizer,
  FileSourceCheckpointRepository,
  LocalAgentEngramRuntime,
  WorkerExecutionRunner,
  loadAgentEngramConfig,
  resolveProjectIdentity,
  type AgentEngramProviderConfig,
  type CellBoundaryDetectorLike,
  type HostBinding,
  type LLMChatClient,
  type SourceCheckpointRepository,
} from "@agentengram/engine";
import { resolveCodexMode, type CodexIntegrationMode } from "./capabilities.js";
import {
  normalizeCodexHookEvent,
  normalizeCodexHookMessage,
  codexRolloutSourceId,
  readCodexRolloutIncremental,
} from "./codex-transcript-normalizer.js";
import { CODEX_HOOK_EVENTS, CODEX_HOOK_REQUIRED_FIELDS, type CodexHookInput, type CodexHookOutput } from "./types.js";
import { acquireCodexSessionLock } from "./session-lock.js";
import { launchCodexWorker, type CodexWorkerLauncher } from "./worker-runner.js";
import { createCodexHostBindings, persistCodexHostBindings } from "./host-binding.js";

export interface CodexHookHandlerOptions {
  readonly homeDir?: string;
  readonly mode?: CodexIntegrationMode;
  readonly llmClient?: LLMChatClient;
  readonly boundaryDetector?: CellBoundaryDetectorLike;
  readonly formationEnabled?: boolean;
  /** Embedded preserves deterministic/in-process use; sidecar is the CLI fast path. */
  readonly workerExecutionMode?: "embedded" | "sidecar";
  /** Injectable wake-up seam used by system tests and custom launchers. */
  readonly workerLauncher?: CodexWorkerLauncher;
  readonly recallLimit?: number;
  readonly recallTokenBudget?: number;
  /** Fail-open is mandatory for the CLI; false is useful only in deterministic tests. */
  readonly failOpen?: boolean;
}

export type CodexHookHandler = (input: CodexHookInput) => Promise<CodexHookOutput | undefined>;

/** Creates the command-hook entrypoint used by both plugin and system tests. */
export function createCodexHookHandler(options: CodexHookHandlerOptions = {}): CodexHookHandler {
  resolveCodexMode(options.mode);
  return async (input) => {
    try {
      return await handleCodexHook(input, options);
    } catch (error) {
      if (options.failOpen === false) throw error;
      writeDiagnostic(error);
      return undefined;
    }
  };
}

/** Executes one isolated Hook process against the shared local AgentEngram store. */
export async function handleCodexHook(
  input: CodexHookInput,
  options: CodexHookHandlerOptions = {},
): Promise<CodexHookOutput | undefined> {
  validateCodexHookInput(input);
  const project = await resolveProjectIdentity(input.cwd);
  const installed = await loadAgentEngramConfig({ cwd: input.cwd, ...(options.homeDir ? { homeDir: options.homeDir } : {}) });
  const configuredMode = installed.config.adapters?.codex?.mode ?? installed.config.context?.defaultMode;
  resolveCodexMode(options.mode ?? configuredMode);
  const homeDir = options.homeDir ?? installed.config.dataDir ?? defaultHomeDir();
  const workerExecutionMode = options.workerExecutionMode ?? (options.llmClient ? "embedded" : "sidecar");
  const formationPolicy = installed.config.adapters?.codex?.models?.formation ?? installed.config.models?.formation;
  const formationPolicyEnabled = options.formationEnabled
    ?? formationPolicy?.strategy !== "disabled";
  const formationEnabled = formationPolicyEnabled
    && (options.llmClient !== undefined || hasConfiguredFormationProvider(installed.config.provider));
  // Sidecar hooks deliberately do not construct provider clients. Only the
  // detached worker reads provider credentials and executes model-backed work.
  const llmClient = workerExecutionMode === "embedded" && formationEnabled
    ? options.llmClient ?? defaultLLMClientFromEnvironment(installed.config.provider)
    : undefined;
  const runtime = await LocalAgentEngramRuntime.create({
    homeDir,
    projectId: project.projectId,
    contextMode: "enhance",
    workerExecutionMode,
    ...(llmClient ? {
      llmClient,
      summarizer: new LLMCompactSummarizer({ client: llmClient }),
    } : {}),
    ...(options.boundaryDetector ? { boundaryDetector: options.boundaryDetector } : {}),
    ...(options.recallLimit === undefined ? {} : { recallLimit: options.recallLimit }),
    ...(options.recallTokenBudget === undefined ? {} : { recallTokenBudget: options.recallTokenBudget }),
  });
  const releaseLock = await acquireCodexSessionLock(homeDir, input.session_id).catch(async (error) => {
    await runtime.close();
    throw error;
  });
  const hostBindings = createCodexHostBindings(input, project);
  const threadId = hostBindings.active.threadId;
  const sourceCheckpoints = new FileSourceCheckpointRepository(
    join(homeDir, "projects", project.projectId, "source-checkpoints", "codex"),
  );
  try {
    await persistCodexHostBindings(homeDir, hostBindings);
    await mirrorCodexHookTranscript(runtime, input, threadId, sourceCheckpoints, hostBindings.active);
    switch (input.hook_event_name) {
      case "UserPromptSubmit": {
        if (!input.turn_id || !input.prompt?.trim()) return undefined;
        // Codex invokes this hook before persisting the submitted user item.
        // The synthetic record guarantees transcript truth even if the turn crashes.
        await runtime.appendTranscript(normalizeCodexHookMessage({
          sessionId: input.session_id,
          threadId,
          turnId: input.turn_id,
          role: "user",
          text: input.prompt,
          hostBinding: hostBindings.active,
        }));
        const recall = runtime.longTerm.search({
          query: input.prompt,
          projectId: project.projectId,
          maxResults: options.recallLimit ?? 5,
          tokenBudget: options.recallTokenBudget ?? 2_000,
          audience: {
            projectId: project.projectId,
            worktreeId: project.worktreeId,
            ...(installed.config.identities?.userId ? { userId: installed.config.identities.userId } : {}),
            ...(installed.config.identities?.agentId ? { agentId: installed.config.identities.agentId } : {}),
            ...(installed.config.identities?.teamId
              ? { teamIds: [installed.config.identities.teamId] }
              : {}),
          },
        });
        if (!recall.context) return undefined;
        return {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: recall.context,
          },
        };
      }
      case "Stop": {
        if (input.turn_id && input.last_assistant_message?.trim()) {
          await runtime.appendTranscript(normalizeCodexHookMessage({
            sessionId: input.session_id,
            threadId,
            turnId: input.turn_id,
            role: "assistant",
            text: input.last_assistant_message,
            hostBinding: hostBindings.active,
          }));
        }
        // Codex exposes no SessionEnd hook. Treat a completed main-agent turn
        // as the hard Cell boundary so the final turn cannot remain unformed forever.
        if (formationEnabled) {
          if (workerExecutionMode === "embedded") {
            await runtime.flushCellFormation({ sessionId: input.session_id, threadId });
          } else {
            await runtime.enqueueCellFormation({ sessionId: input.session_id, threadId, isFinal: true });
            await wakeCodexSidecar(options.workerLauncher ?? launchCodexWorker, input.cwd, homeDir);
          }
        }
        return undefined;
      }
      case "PreCompact": {
        // Preserve and form the complete pre-compact fact window before Codex
        // replaces its own model history. The hook does not replace compaction.
        if (formationEnabled) {
          if (workerExecutionMode === "embedded") {
            await runtime.flushCellFormation({ sessionId: input.session_id, threadId });
          } else {
            await runtime.enqueueCellFormation({ sessionId: input.session_id, threadId, isFinal: true });
            await wakeCodexSidecar(options.workerLauncher ?? launchCodexWorker, input.cwd, homeDir);
          }
        }
        return undefined;
      }
      case "SubagentStart":
        // The raw hook fact records child id/type and spawning turn. Codex does
        // not expose an exact nested parent id, so the root session is retained
        // as the only authoritative parent binding.
        return undefined;
      case "SubagentStop":
        // Subagent evidence is portable, but automatic child formation is
        // skipped to avoid duplicating the result later returned to its parent.
        return undefined;
      default:
        return undefined;
    }
  } finally {
    try {
      await runtime.close();
    } finally {
      await releaseLock();
    }
  }
}

export async function mirrorCodexHookTranscript(
  runtime: Pick<LocalAgentEngramRuntime, "appendTranscript">,
  input: CodexHookInput,
  threadId: string,
  sourceCheckpoints: SourceCheckpointRepository,
  hostBinding?: HostBinding,
): Promise<void> {
  const transcriptPath = input.hook_event_name === "SubagentStart"
    ? undefined
    : input.hook_event_name === "SubagentStop"
      ? input.agent_transcript_path ?? input.transcript_path
      : input.transcript_path;
  if (transcriptPath) {
    const sourceId = await codexRolloutSourceId({
      path: transcriptPath,
      sessionId: input.session_id,
      threadId,
    });
    const checkpoint = await sourceCheckpoints.load(sourceId);
    const result = await readCodexRolloutIncremental({
      path: transcriptPath,
      sessionId: input.session_id,
      threadId,
      ...(checkpoint ? { checkpoint } : {}),
      ...(hostBinding ? { hostBinding } : {}),
    });
    if (result.records.length > 0) await runtime.appendTranscript(result.records);
    // The source waterline advances only after portable raw/normalized truth is
    // durable. Formation has its own cursor and may fail independently.
    if (result.checkpoint) await sourceCheckpoints.save(result.checkpoint);
  }
  await runtime.appendTranscript(normalizeCodexHookEvent(input, threadId, hostBinding));
}

/** Routes Codex's detached launcher through Engine's common worker topology contract. */
async function wakeCodexSidecar(launcher: CodexWorkerLauncher, cwd: string, homeDir: string): Promise<void> {
  const runner = new WorkerExecutionRunner({
    mode: "sidecar",
    sidecar: { ensureRunning: () => Promise.resolve(launcher({ cwd, homeDir })) },
  });
  await runner.ensureAvailable();
}

export function validateCodexHookInput(input: CodexHookInput): void {
  if (!input || typeof input !== "object") throw new Error("Codex hook input must be an object");
  if (!input.session_id?.trim()) throw new Error("Codex hook input requires session_id");
  if (!input.cwd?.trim()) throw new Error("Codex hook input requires cwd");
  if (!input.hook_event_name?.trim()) throw new Error("Codex hook input requires hook_event_name");
  if (!(CODEX_HOOK_EVENTS as readonly string[]).includes(input.hook_event_name)) {
    throw new Error(`unsupported Codex hook event: ${input.hook_event_name}`);
  }
  for (const field of CODEX_HOOK_REQUIRED_FIELDS[input.hook_event_name]) requirePresent(input, field);
  if (!input.model?.trim()) throw new Error("Codex hook input requires model");
  // Codex's generated PreCompact/PostCompact schemas intentionally omit the
  // permission mode. Every other event carries it and is validated here.
  if (input.hook_event_name !== "PreCompact" && input.hook_event_name !== "PostCompact") {
    requireText(input.permission_mode, input.hook_event_name, "permission_mode");
  }
  switch (input.hook_event_name) {
    case "SessionStart":
      requireText(input.source, input.hook_event_name, "source");
      break;
    case "UserPromptSubmit":
      requireText(input.turn_id, input.hook_event_name, "turn_id");
      requireText(input.prompt, input.hook_event_name, "prompt");
      break;
    case "PreToolUse":
    case "PostToolUse":
      requireText(input.turn_id, input.hook_event_name, "turn_id");
      requireText(input.tool_name, input.hook_event_name, "tool_name");
      requireText(input.tool_use_id, input.hook_event_name, "tool_use_id");
      requirePresent(input, "tool_input");
      if (input.hook_event_name === "PostToolUse") requirePresent(input, "tool_response");
      break;
    case "PermissionRequest":
      requireText(input.turn_id, input.hook_event_name, "turn_id");
      requireText(input.tool_name, input.hook_event_name, "tool_name");
      requirePresent(input, "tool_input");
      break;
    case "PreCompact":
    case "PostCompact":
      requireText(input.turn_id, input.hook_event_name, "turn_id");
      requireText(input.trigger, input.hook_event_name, "trigger");
      break;
    case "SubagentStart":
      requireText(input.turn_id, input.hook_event_name, "turn_id");
      requireText(input.agent_id, input.hook_event_name, "agent_id");
      requireText(input.agent_type, input.hook_event_name, "agent_type");
      break;
    case "SubagentStop":
      requireText(input.turn_id, input.hook_event_name, "turn_id");
      requireText(input.agent_id, input.hook_event_name, "agent_id");
      requireText(input.agent_type, input.hook_event_name, "agent_type");
      requirePresent(input, "agent_transcript_path");
      requirePresent(input, "last_assistant_message");
      requirePresent(input, "stop_hook_active");
      break;
    case "Stop":
      requireText(input.turn_id, input.hook_event_name, "turn_id");
      requirePresent(input, "last_assistant_message");
      requirePresent(input, "stop_hook_active");
      break;
  }
}

function requireText(value: unknown, event: string, field: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${event} Hook input requires ${field}`);
}

function requirePresent(input: object, field: string): void {
  if (!(field in input)) throw new Error(`${"hook_event_name" in input ? String(input.hook_event_name) : "Codex"} Hook input requires ${field}`);
}

function defaultHomeDir(): string {
  return process.env.AGENTENGRAM_HOME ?? join(homedir(), ".agentengram");
}

/** Creates the adapter's default Qwen formation client without exposing secrets. */
function defaultLLMClientFromEnvironment(provider: AgentEngramProviderConfig = {}): LLMChatClient | undefined {
  if (process.env.AGENTENGRAM_CODEX_FORMATION === "0") return undefined;
  if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") return undefined;
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

function hasConfiguredFormationProvider(provider: AgentEngramProviderConfig = {}): boolean {
  if (process.env.AGENTENGRAM_CODEX_FORMATION === "0") return false;
  if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") return false;
  return Boolean(process.env[provider.apiKeyEnv ?? "DASHSCOPE_API_KEY"]);
}

function writeDiagnostic(error: unknown): void {
  // Hook stdout is model-visible. Diagnostics must stay on stderr so a failure
  // cannot become accidental additional context.
  process.stderr.write(`[AgentEngram Codex hook] ${error instanceof Error ? error.message : String(error)}\n`);
}
