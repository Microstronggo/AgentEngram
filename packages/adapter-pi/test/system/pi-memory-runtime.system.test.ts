import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalAgentEngramRuntime,
  resolveProjectIdentity,
  type CompactSummarizer,
  type LLMChatClient,
  type LLMMessage,
} from "@agentengram/engine";
import { createPiExtension } from "../../src/extension.js";
import {
  createRuntimeEngineFacade,
  fromAgentMessage,
  toAgentMessage,
} from "../../src/runtime-engine-facade.js";
import { CHECKPOINT_CUSTOM_TYPE, type EngineFacade } from "../../src/types.js";
import { normalizePiBranchTranscript } from "../../src/transcript/index.js";
import {
  FakePi,
  fakePiContext,
  piTextMessage,
  piToolCallMessage,
  piToolResultMessage,
} from "../fixtures/fake-pi.js";

const fakeSummarizer: CompactSummarizer = {
  summarize: async ({ messages }) => ({
    text: `summary:${messages.map((message) => message.id).join(",")}`,
    model: "fake-current-model",
  }),
};

const runtimes: LocalAgentEngramRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe("Pi system integration with real AgentEngram runtime", () => {
  it("invokes every registered Pi hook and mirrors raw plus normalized transcript data", async () => {
    const { cwd, runtime, engine } = await createHarness({ mode: "managed-context" });
    const pi = new FakePi();
    createPiExtension({ mode: "managed-context", engine })(pi);
    const branch = [
      piTextMessage("entry-user", "user", "请记住：AgentEngram 默认使用 managed-context。"),
      piToolCallMessage("entry-tool-call", "tool-call-1", "Read"),
      piToolResultMessage("entry-tool-result", "tool-call-1", "package manager is pnpm"),
      piTextMessage("entry-assistant", "assistant", "已确认 managed-context 与 pnpm 约定。"),
    ];
    const context = systemContext(cwd, "session-hooks", "thread-hooks", branch, 128_000);

    await expect(pi.emit("session_start", { type: "session_start", reason: "new" }, context)).resolves.toBeUndefined();
    await expect(pi.emit("before_agent_start", { type: "before_agent_start" }, context)).resolves.toBeUndefined();
    await expect(pi.emit("tool_call", { toolCallId: "tool-call-1", toolName: "Read" }, context)).resolves.toBeUndefined();
    await expect(pi.emit("tool_result", { toolCallId: "tool-call-1", isError: false }, context)).resolves.toBeUndefined();
    await expect(pi.emit("turn_end", { turnIndex: 1 }, context)).resolves.toBeUndefined();
    await expect(pi.emit("agent_end", { type: "agent_end" }, context)).resolves.toBeUndefined();

    const contextResult = await pi.emit("context", { messages: [piUser("live-user", "继续")] }, context);
    expect(textOf(contextResult)).toContain("managed-context");

    const compactResult = await pi.emit("session_before_compact", {
      preparation: { firstKeptEntryId: "entry-tool-result", settings: { keepRecentTokens: 1 } },
      branchEntries: branch,
      signal: new AbortController().signal,
    }, context);
    expect(compactResult).toMatchObject({
      compaction: {
        firstKeptEntryId: "entry-tool-result",
        details: { agentengram: { summaryModel: "fake-current-model" } },
      },
    });

    await expect(pi.emit("session_compact", { type: "session_compact" }, context)).resolves.toBeUndefined();
    await expect(pi.emit("session_before_tree", { preparation: { oldLeafId: "thread-hooks" } }, context)).resolves.toBeUndefined();
    await expect(pi.emit("session_tree", { oldLeafId: "thread-hooks", newLeafId: "thread-hooks-next" }, context)).resolves.toBeUndefined();
    await expect(pi.emit("session_shutdown", { type: "session_shutdown", reason: "test" }, context)).resolves.toBeUndefined();

    const raw = await runtime.transcripts.readRaw("session-hooks");
    const normalized = await runtime.transcripts.readNormalized("session-hooks");
    const originalThreadRaw = raw.filter((record) => record.frameworkThreadId === "thread-hooks");
    const originalThreadNormalized = normalized.filter((entry) => entry.threadId === "thread-hooks");
    expect(originalThreadRaw.map((record) => record.frameworkEntryId)).toEqual([
      "entry-user",
      "entry-tool-call",
      "entry-tool-result",
      "entry-assistant",
    ]);
    expect(originalThreadNormalized.map((entry) => entry.kind)).toEqual(["message", "tool_call", "tool_result", "message"]);
    expect(raw.some((record) => record.frameworkThreadId === "thread-hooks-next")).toBe(true);
    expect(originalThreadRaw[0]?.rawFrameworkPayload).toMatchObject({ id: "entry-user" });
    expect(originalThreadNormalized[2]?.sourceRef).toBe("agentengram://transcript/session-hooks/thread-hooks/entry-tool-result");
  });

  it("stores project memory through Pi tools and injects recall on the next context hook", async () => {
    const { cwd, projectId, engine } = await createHarness({ mode: "enhance" });
    const pi = new FakePi();
    createPiExtension({ engine })(pi);
    const context = systemContext(cwd, "session-memory", "thread-memory");

    const remembered = await pi.executeTool("memory_remember", {
      id: "memory-package-manager",
      name: "Package manager",
      description: "Project package-manager decision",
      content: "AgentEngram uses pnpm for package management and test commands.",
      type: "project",
      scope: "project",
      kind: "decision",
      projectId,
      sourceRefs: ["pi:test"],
    }, context);

    expect(remembered).toMatchObject({ details: { ok: true } });

    const result = await pi.emit("context", {
      messages: [piUser("u-next", "接下来应该用什么包管理器运行 AgentEngram 测试？pnpm 约定是什么？")],
    }, context);

    expect(textOf(result)).toContain("<agent-engram-context>");
    expect(textOf(result)).toContain("AgentEngram uses pnpm");

    const otherProject = await createProjectDir("agentengram-other-project");
    const otherContext = systemContext(otherProject, "session-other", "thread-other");
    const isolated = await pi.emit("context", {
      messages: [piUser("u-other", "pnpm 约定是什么？")],
    }, otherContext);
    expect(textOf(isolated)).not.toContain("AgentEngram uses pnpm");

    await pi.executeTool("memory_forget", {
      scope: "project",
      id: "memory-package-manager",
      projectId,
    }, context);
    const afterForget = await pi.emit("context", {
      messages: [piUser("u-after-forget", "pnpm 约定是什么？")],
    }, context);
    expect(textOf(afterForget)).not.toContain("AgentEngram uses pnpm");
  });

  it("forms long-term memory from mirrored Pi transcript and recalls it on the next context hook", async () => {
    const llmClient = new PiFormationLLMClient();
    const { cwd, runtime, engine } = await createHarness({ mode: "managed-context", llmClient });
    const pi = new FakePi();
    createPiExtension({ mode: "managed-context", engine })(pi);
    const branch = [
      piTextMessage("cell-user", "user", "Always ask me before creating a git commit."),
      piTextMessage("cell-assistant", "assistant", "I will ask for confirmation before committing."),
    ];
    const context = systemContext(cwd, "session-cell", "thread-cell", branch);

    await pi.emit("turn_end", { type: "turn_end", turnIndex: 0 }, context);
    await expect(runtime.drainFormation({ timeoutMs: 5_000 })).resolves.toBe("drained");

    const raw = await runtime.transcripts.readRaw("session-cell");
    expect(raw.map(({ frameworkEntryId }) => frameworkEntryId)).toEqual(["cell-user", "cell-assistant"]);
    const stored = runtime.application.search({
      text: "confirmation git commit",
      projectId: (await resolveProjectIdentity(cwd)).projectId,
      scope: "project",
      limit: 10,
    }).map(({ record }) => record);
    expect(stored.map(({ memoryClass }) => memoryClass)).toEqual(expect.arrayContaining(["episodic", "procedural"]));

    const projected = await pi.emit("context", {
      messages: [piUser("cell-next", "Please create the git commit.")],
    }, context);
    expect(textOf(projected)).toContain("Ask for explicit confirmation before creating a git commit");
    expect(llmClient.stages).toEqual(["boundary", "episode", "derived"]);
  });

  it("projects managed short-term context, checkpoints it, and restores it through Pi resume", async () => {
    const { cwd, engine } = await createHarness({ mode: "managed-context" });
    const pi = new FakePi();
    createPiExtension({ mode: "managed-context", engine })(pi);
    const context = systemContext(cwd, "session-managed", "thread-managed", [], 128_000);
    const hugeToolResult = "large tool output ".repeat(20_000);

    const projected = await pi.emit("context", {
      messages: [
        piUser("u1", "读取大型日志并继续。"),
        piAssistantToolCall("a1", "tool-1", "Read", { path: "big.log" }),
        piToolResult("tool-1", hugeToolResult),
        piUser("u2", "基于日志继续分析。"),
      ],
    }, context);

    expect(textOf(projected)).toContain("[Tool result offloaded: blob:sha256:");

    await pi.emit("session_shutdown", { type: "session_shutdown", reason: "test" }, context);
    const pointer = pi.entries.find((entry) => entry.customType === CHECKPOINT_CUSTOM_TYPE)?.data;
    expect(pointer).toMatchObject({ reason: "shutdown", frameworkSessionId: "session-managed" });

    const resumedPi = new FakePi();
    createPiExtension({ mode: "managed-context", engine })(resumedPi);
    const resumedContext = systemContext(
      cwd,
      "session-managed",
      "thread-managed",
      [{ type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: pointer }],
      128_000,
    );

    await resumedPi.emit("session_start", { type: "session_start", reason: "resume" }, resumedContext);
    const restored = await resumedPi.emit("context", { messages: [] }, resumedContext);

    expect(textOf(restored)).toContain("[Tool result offloaded: blob:sha256:");
    expect(textOf(restored)).toContain("基于日志继续分析");
  });

  it("shares project memory and isolates local memory across Pi worktree contexts", async () => {
    const { main, worktree } = await createWorktreePair();
    const identity = await resolveProjectIdentity(main);
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-pi-worktree-home-"));
    const runtime = await LocalAgentEngramRuntime.create({ homeDir, projectId: identity.projectId, contextMode: "enhance" });
    runtimes.push(runtime);
    const runtimeFacade = createRuntimeEngineFacade(runtime);
    const engine: EngineFacade = {
      memoryApplication: runtime.application,
      enhanceContext: (request) => runtimeFacade.enhanceContext(request),
      handleEvent: (event) => runtimeFacade.handleEvent(event),
    };
    const pi = new FakePi();
    createPiExtension({ engine })(pi);
    const mainContext = systemContext(main, "session-main", "thread-main");
    const worktreeContext = systemContext(worktree, "session-feature", "thread-feature");

    await pi.executeTool("memory_remember", {
      id: "shared-project", name: "Shared project rule", description: "Shared across worktrees",
      content: "Project memory uses shared-project-token.", type: "project", scope: "project",
    }, mainContext);
    await pi.executeTool("memory_remember", {
      id: "same-local", name: "Main local rule", description: "Main checkout only",
      content: "Main checkout uses alpha-local-token.", type: "project", scope: "local",
    }, mainContext);
    await pi.executeTool("memory_remember", {
      id: "same-local", name: "Feature local rule", description: "Feature checkout only",
      content: "Feature checkout uses beta-local-token.", type: "project", scope: "local",
    }, worktreeContext);

    const mainView = await pi.emit("context", { messages: [piUser("main-query", "shared-project-token alpha-local-token beta-local-token")] }, mainContext);
    expect(textOf(mainView)).toContain("shared-project-token");
    expect(textOf(mainView)).toContain("alpha-local-token");
    expect(textOf(mainView)).not.toContain("Feature checkout uses beta-local-token");
    const featureView = await pi.emit("context", { messages: [piUser("feature-query", "shared-project-token alpha-local-token beta-local-token")] }, worktreeContext);
    expect(textOf(featureView)).toContain("shared-project-token");
    expect(textOf(featureView)).toContain("beta-local-token");
    expect(textOf(featureView)).not.toContain("Main checkout uses alpha-local-token");

    expect(textOf(await pi.executeTool("memory_read", { scope: "local", id: "same-local" }, mainContext))).toContain("alpha-local-token");
    expect(textOf(await pi.executeTool("memory_read", { scope: "local", id: "same-local" }, worktreeContext))).toContain("beta-local-token");
    await pi.executeTool("memory_forget", { scope: "local", id: "same-local" }, mainContext);
    expect(textOf(await pi.executeTool("memory_read", { scope: "local", id: "same-local" }, worktreeContext))).toContain("beta-local-token");
  });

  it("executes Pi upsert, revision conflict, update, and correction against the real runtime", async () => {
    const { cwd, engine } = await createHarness({ mode: "enhance" });
    const pi = new FakePi();
    createPiExtension({ engine })(pi);
    const context = systemContext(cwd, "session-write", "thread-write");
    const base = {
      id: "write-rule", name: "Write rule", description: "Pi write lifecycle",
      content: "Use npm for p0-write-token.", type: "project", scope: "project", idempotencyKey: "pi-write-1",
    };
    const created = await pi.executeTool("memory_upsert", base, context);
    const duplicate = await pi.executeTool("memory_upsert", base, context);
    expect(created).toMatchObject({ details: { value: { action: "created", record: { revision: 1 } } } });
    expect(duplicate).toMatchObject({ details: { value: { action: "duplicate", record: { id: "write-rule" } } } });
    const updated = await pi.executeTool("memory_update", {
      ...base, content: "Use pnpm for p0-write-token.", targetMemoryId: "write-rule", expectedRevision: 1,
    }, context);
    expect(updated).toMatchObject({ details: { value: { action: "updated", record: { revision: 2 } } } });
    const stale = await pi.executeTool("memory_update", {
      ...base, content: "Use yarn for p0-write-token.", targetMemoryId: "write-rule", expectedRevision: 1,
    }, context);
    expect(stale).toMatchObject({ details: { value: { action: "conflict", record: { revision: 2 } } } });
    const corrected = await pi.executeTool("memory_correct", {
      name: "Write rule correction", description: "Final Pi rule", content: "Use pnpm only for p0-write-token.",
      scope: "project", targetMemoryId: "write-rule", expectedRevision: 2,
    }, context);
    expect(corrected).toMatchObject({ details: { value: { action: "superseded", record: { supersedes: "write-rule" } } } });
    const recalled = await pi.emit("context", { messages: [piUser("write-query", "p0-write-token package manager")] }, context);
    expect(textOf(recalled)).toContain("Use pnpm only for p0-write-token");
    expect(textOf(recalled)).not.toContain("Use npm for p0-write-token");
  });
});

async function createHarness(input: {
  readonly mode: "enhance" | "managed-context";
  readonly llmClient?: LLMChatClient;
}) {
  const cwd = await createProjectDir(`agentengram-pi-system-${input.mode}`);
  const { projectId } = await resolveProjectIdentity(cwd);
  const homeDir = await mkdtemp(join(tmpdir(), "agentengram-pi-system-home-"));
  const runtime = await LocalAgentEngramRuntime.create({
    homeDir,
    projectId,
    contextMode: input.mode,
    summarizer: fakeSummarizer,
    toolResultTokenBudget: 1_000,
    ...(input.llmClient === undefined ? {} : { llmClient: input.llmClient }),
  });
  runtimes.push(runtime);
  const runtimeFacade = createRuntimeEngineFacade(runtime);
  const engine: EngineFacade = {
    managedContextReady: input.mode === "managed-context",
    memoryApplication: runtime.application,
    handleEvent: (event) => runtimeFacade.handleEvent(event),
    enhanceContext: (request) => runtimeFacade.enhanceContext(request),
    buildManagedContext: (request) => runtimeFacade.buildManagedContext(request),
    createCheckpoint: (reason, request) => runtime.createCheckpoint({
      sessionId: request.sessionId,
      threadId: request.threadId,
      reason,
      ...(request.canonicalMessages === undefined
        ? {}
        : { messages: request.canonicalMessages.map(toAgentMessage) }),
      ...(request.payload === undefined ? {} : { state: { piPayload: request.payload } }),
    }),
    compact: (request) => runtimeFacade.compact(request),
    recordTranscript: async (request) => {
      const entries = normalizePiBranchTranscript({
        sessionId: request.sessionId,
        threadId: request.threadId,
        branchEntries: request.branchEntries,
      });
      await runtime.appendTranscript(entries.map(({ raw, normalized }) => ({ raw, normalized })));
      if (request.reason === "turn_end" || request.reason === "agent_end") {
        void runtime.scheduleCellFormation({ sessionId: request.sessionId, threadId: request.threadId });
      } else if (request.reason === "session_shutdown" || request.reason === "session_before_tree") {
        await runtime.flushCellFormation({ sessionId: request.sessionId, threadId: request.threadId });
      }
    },
    restoreCheckpoint: async (request) => {
      if (!request.pointer) return { status: "unavailable" };
      const recovered = await runtime.recover(request.pointer);
      return recovered.status === "restored"
        ? { status: "restored", messages: recovered.messages.map(fromAgentMessage) }
        : { status: "unavailable" };
    },
    rebuildFromCanonical: (request) => {
      const rebuilt = runtime.rebuildFromCanonical(
        request.sessionId,
        request.threadId,
        request.canonicalMessages.map(toAgentMessage),
      );
      return { status: "rebuilt", messages: rebuilt.messages.map(fromAgentMessage) };
    },
  };
  return { cwd, projectId, runtime, engine };
}

/** Deterministic Pi-system model double for all three Cell formation stages. */
class PiFormationLLMClient implements LLMChatClient {
  readonly stages: string[] = [];

  async chat(messages: readonly LLMMessage[]) {
    const system = messages[0]?.content ?? "";
    if (system.includes("Cell boundary detector")) {
      this.stages.push("boundary");
      return { content: '{"boundaries":[2],"should_wait":true}', model: "fake-qwen" };
    }
    if (system.includes("episodic memory extractor")) {
      this.stages.push("episode");
      return {
        model: "fake-qwen",
        content: JSON.stringify({ candidates: [{
          name: "Commit confirmation agreement",
          description: "A commit workflow agreement was made.",
          content: "The user required confirmation before git commits and the assistant accepted.",
          type: "project",
          scope: "project",
          memoryClass: "episodic",
          kind: "decision",
          confidence: 0.95,
        }] }),
      };
    }
    this.stages.push("derived");
    return {
      model: "fake-qwen",
      content: JSON.stringify({ candidates: [{
        name: "Confirm before commit",
        description: "Persistent git workflow rule.",
        content: "Ask for explicit confirmation before creating a git commit.",
        type: "project",
        scope: "project",
        memoryClass: "procedural",
        kind: "convention",
        confidence: 0.98,
      }] }),
    };
  }
}

async function createProjectDir(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `${name}-`));
  await mkdir(join(path, "src"), { recursive: true });
  return path;
}

async function createWorktreePair(): Promise<{ readonly main: string; readonly worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentengram-pi-worktrees-"));
  const main = join(root, "main");
  const worktree = join(root, "feature");
  const worktreeGitDir = join(main, ".git", "worktrees", "feature");
  await mkdir(worktreeGitDir, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");
  await writeFile(join(worktreeGitDir, "commondir"), "../..\n", "utf8");
  await writeFile(join(worktreeGitDir, "gitdir"), `${join(worktree, ".git")}\n`, "utf8");
  return { main, worktree };
}

function systemContext(
  cwd: string,
  sessionId: string,
  leafId: string,
  branch: readonly unknown[] = [],
  contextWindow = 128_000,
) {
  return fakePiContext({
    cwd,
    sessionManager: {
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getLeafId: () => leafId,
      getBranch: () => branch,
    },
    getContextUsage: () => ({ tokens: null, contextWindow, percent: null }),
  });
}

function piUser(id: string, text: string) {
  return { id, role: "user", content: [{ type: "text", text }], timestamp: Date.parse("2026-06-23T00:00:00.000Z") };
}

function piAssistantToolCall(id: string, toolCallId: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
    timestamp: Date.parse("2026-06-23T00:00:01.000Z"),
  };
}

function piToolResult(toolCallId: string, content: string) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "Read",
    content,
    isError: false,
    timestamp: Date.parse("2026-06-23T00:00:02.000Z"),
  };
}

function textOf(result: unknown): string {
  return JSON.stringify(result);
}
