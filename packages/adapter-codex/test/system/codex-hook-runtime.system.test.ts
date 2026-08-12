import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileHostBindingRepository, resolveProjectIdentity, type LLMChatClient } from "@agentengram/engine";
import { createCodexHookHandler } from "../../src/hook-runtime.js";
import { runCodexWorker } from "../../src/worker-runner.js";
import type { CodexHookInput } from "../../src/types.js";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Codex Hook + AgentEngram system", () => {
  it("rejects a project config that attempts unsupported managed ownership", async () => {
    const cwd = await temporaryDirectory("agentengram-codex-config-project-");
    const homeDir = await temporaryDirectory("agentengram-codex-config-home-");
    await mkdir(join(cwd, ".agentengram"), { recursive: true });
    await writeFile(join(cwd, ".agentengram", "config.json"), `${JSON.stringify({
      schemaVersion: 1, context: { defaultMode: "managed-context" },
    })}\n`, "utf8");
    const handler = createCodexHookHandler({ homeDir, failOpen: false, formationEnabled: false });

    await expect(handler({
      session_id: "session-config", transcript_path: null, cwd, hook_event_name: "SessionStart",
      model: "gpt-test", permission_mode: "default", source: "startup",
    })).rejects.toThrow(/managed-context/u);
  });

  it("mirrors rollout truth, forms typed memory at Stop, and injects recall next turn", async () => {
    // Keep hook-synthesized messages on the fixture date. Cell boundaries
    // intentionally split on date changes, so real wall time would make this
    // single-Cell contract become a two-Cell test after 2026-06-30.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-30T00:00:07.000Z"));
    const cwd = await temporaryDirectory("agentengram-codex-project-");
    const homeDir = await temporaryDirectory("agentengram-codex-home-");
    const rollout = join(cwd, "rollout.jsonl");
    await writeFile(rollout, fixtureRollout(), "utf8");
    const llmClient = new FormationLLMClient();
    const handler = createCodexHookHandler({ homeDir, llmClient, failOpen: false });

    await handler(hook("SessionStart", cwd, rollout));
    await handler(hook("SessionStart", cwd, rollout));
    await handler({
      ...hook("Stop", cwd, rollout),
      turn_id: "turn-1",
      last_assistant_message: "I will ask for explicit confirmation before committing.",
    });

    const recalled = await handler({
      ...hook("UserPromptSubmit", cwd, rollout),
      turn_id: "turn-2",
      prompt: "What confirmation rule applies before a git commit?",
    });
    expect(recalled).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining("Ask for explicit confirmation before every git commit"),
      },
    });

    const projectId = (await resolveProjectIdentity(cwd)).projectId;
    const rawPath = join(homeDir, "projects", stableId(projectId), "transcripts", "session-1", "raw.jsonl");
    const normalizedPath = join(homeDir, "projects", stableId(projectId), "transcripts", "session-1", "normalized.jsonl");
    const rawLines = (await readFile(rawPath, "utf8")).trim().split("\n");
    const normalized = (await readFile(normalizedPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    // Repeated SessionStart mirrors the same rollout idempotently; Hook facts
    // are also stable by event/turn discriminator.
    expect(new Set(rawLines.map((line) => JSON.parse(line).id)).size).toBe(rawLines.length);
    expect(normalized.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["message", "tool_call", "tool_result", "compaction"]));
    expect(llmClient.stages).toEqual(["boundary", "episode", "derived"]);
  });

  it("fails open without writing model-visible stdout data", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const handler = createCodexHookHandler({ failOpen: true, formationEnabled: false });
    await expect(handler({} as CodexHookInput)).resolves.toBeUndefined();
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("keeps the sidecar Hook path model-free and lets the worker form queued memory", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-30T00:00:07.000Z"));
    const cwd = await temporaryDirectory("agentengram-codex-sidecar-project-");
    const homeDir = await temporaryDirectory("agentengram-codex-sidecar-home-");
    const rollout = join(cwd, "rollout.jsonl");
    await writeFile(rollout, fixtureRollout(), "utf8");
    const llmClient = new FormationLLMClient();
    const workerLauncher = vi.fn(async () => undefined);
    const handler = createCodexHookHandler({
      homeDir,
      llmClient,
      workerExecutionMode: "sidecar",
      workerLauncher,
      failOpen: false,
    });

    await handler({
      ...hook("Stop", cwd, rollout),
      turn_id: "turn-1",
      last_assistant_message: "I will ask for explicit confirmation before committing.",
    });

    expect(workerLauncher).toHaveBeenCalledOnce();
    expect(llmClient.stages).toEqual([]);

    // Real worker orchestration drains the same project-local durable queue;
    // the injected client keeps this system test deterministic and offline.
    vi.useRealTimers();
    await expect(runCodexWorker({
      cwd,
      homeDir,
      llmClient,
      idleTimeoutMs: 50,
      pollIntervalMs: 5,
    })).resolves.toBe("completed");
    expect(llmClient.stages).toEqual(["boundary", "episode", "derived"]);

    const recalled = await handler({
      ...hook("UserPromptSubmit", cwd, rollout),
      turn_id: "turn-2",
      prompt: "What confirmation rule applies before a git commit?",
    });
    expect(recalled?.hookSpecificOutput?.additionalContext)
      .toContain("Ask for explicit confirmation before every git commit");
  });

  it("persists portable root and child HostBindings across the Subagent lifecycle", async () => {
    const cwd = await temporaryDirectory("agentengram-codex-binding-project-");
    const homeDir = await temporaryDirectory("agentengram-codex-binding-home-");
    const handler = createCodexHookHandler({ homeDir, formationEnabled: false, failOpen: false });

    await handler({
      session_id: "root-session",
      transcript_path: null,
      cwd,
      hook_event_name: "SessionStart",
      model: "gpt-test",
      permission_mode: "default",
      source: "startup",
    });
    await handler({
      session_id: "root-session",
      turn_id: "spawn-turn",
      agent_id: "child-agent",
      agent_type: "explorer",
      transcript_path: null,
      cwd,
      hook_event_name: "SubagentStart",
      model: "gpt-test",
      permission_mode: "default",
    });
    await handler({
      session_id: "root-session",
      turn_id: "spawn-turn",
      agent_id: "child-agent",
      agent_type: "explorer",
      transcript_path: null,
      agent_transcript_path: null,
      cwd,
      hook_event_name: "SubagentStop",
      model: "gpt-test",
      permission_mode: "default",
      last_assistant_message: "Child completed exploration.",
      stop_hook_active: false,
    });

    const project = await resolveProjectIdentity(cwd);
    const repository = new FileHostBindingRepository(join(homeDir, "host-bindings"));
    const root = await repository.load({
      hostType: "codex",
      hostProjectId: project.projectId,
      hostSessionId: "root-session",
      hostThreadId: "root-session",
    });
    const child = await repository.load({
      hostType: "codex",
      hostProjectId: project.projectId,
      hostSessionId: "root-session",
      hostThreadId: "child-agent",
    });
    expect(root).toMatchObject({ namespaceId: project.projectId, threadId: "root-session" });
    expect(child).toMatchObject({
      namespaceId: project.projectId,
      threadId: "child-agent",
      identity: {
        parentThreadId: "root-session",
        agentId: "child-agent",
      },
    });
  });
});

class FormationLLMClient implements LLMChatClient {
  readonly stages: string[] = [];

  async chat(messages: Parameters<LLMChatClient["chat"]>[0]) {
    const system = messages[0]?.content ?? "";
    if (system.includes("boundary detector")) {
      this.stages.push("boundary");
      return { content: '{"boundaries":[],"should_wait":true}', model: "fake-qwen" };
    }
    if (system.includes("episodic memory extractor")) {
      this.stages.push("episode");
      return { content: JSON.stringify({ candidates: [{
        name: "Commit confirmation episode",
        description: "The user established a commit confirmation rule.",
        content: "The user required explicit confirmation before git commits and the assistant accepted the rule.",
        type: "project", scope: "project", memoryClass: "episodic", confidence: 0.95,
      }] }), model: "fake-qwen" };
    }
    this.stages.push("derived");
    return { content: JSON.stringify({ candidates: [{
      name: "Git commit confirmation rule",
      description: "Ask before creating commits.",
      content: "Ask for explicit confirmation before every git commit.",
      type: "project", scope: "project", kind: "convention", memoryClass: "procedural", confidence: 0.99,
    }] }), model: "fake-qwen" };
  }
}

function hook(event: CodexHookInput["hook_event_name"], cwd: string, transcriptPath: string): CodexHookInput {
  const base = {
    session_id: "session-1",
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: event,
    model: "gpt-test",
  };
  if (event === "SessionStart") return { ...base, hook_event_name: event, permission_mode: "default", source: "startup" };
  if (event === "Stop") return {
    ...base, hook_event_name: event, permission_mode: "default", turn_id: "turn-default",
    last_assistant_message: null, stop_hook_active: false,
  };
  if (event === "UserPromptSubmit") return {
    ...base, hook_event_name: event, permission_mode: "default", turn_id: "turn-default", prompt: "placeholder",
  };
  throw new Error(`unsupported system-test Hook fixture: ${event}`);
}

function fixtureRollout(): string {
  return [
    { timestamp: "2026-06-30T00:00:00.000Z", type: "session_meta", payload: { id: "session-1", cwd: "/project" } },
    { timestamp: "2026-06-30T00:00:01.000Z", type: "turn_context", payload: { turn_id: "turn-1" } },
    { timestamp: "2026-06-30T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Always ask me before creating a git commit." }] } },
    { timestamp: "2026-06-30T00:00:03.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: "{\"cmd\":\"git status\"}" } },
    { timestamp: "2026-06-30T00:00:04.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "clean" } },
    { timestamp: "2026-06-30T00:00:05.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will ask for confirmation before committing." }] } },
    { timestamp: "2026-06-30T00:00:06.000Z", type: "compacted", payload: { window_id: "window-1", message: { content: [{ type: "input_text", text: "Commit confirmation rule retained." }] }, replacement_history: [] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function stableId(value: string): string {
  return /^[A-Za-z0-9._-]+$/u.test(value) ? value : value.replace(/[^A-Za-z0-9._-]/gu, "-");
}
