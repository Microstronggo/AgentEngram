import { describe, expect, it, vi } from "vitest";
import { resolveProjectIdentity, type MemoryRecord } from "@agentengram/engine";
import { Check } from "typebox/value";
import { createErrorReporter } from "./fail-open.js";
import { PI_MEMORY_TOOL_NAMES, registerMemoryTools } from "./memory-tools.js";
import type { PiContext, PiEventName, PiExtensionApi, PiHandler, PiToolDefinition } from "./pi-types.js";
import type { MemoryApplicationFacade } from "./types.js";

class ToolPi implements PiExtensionApi {
  readonly tools = new Map<string, PiToolDefinition>();
  on(_event: PiEventName, _handler: PiHandler): void {}
  appendEntry<T>(_customType: string, _data?: T): void {}
  registerTool(tool: PiToolDefinition): void {
    this.tools.set(tool.name, tool);
  }
}

function context(): PiContext {
  return {
    cwd: "/repo",
    sessionManager: {
      getSessionFile: () => "/sessions/one.jsonl",
      getSessionId: () => "session-1",
    },
    ui: { notify: vi.fn() },
  };
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "memory-1",
    name: "Use pnpm",
    description: "Package manager preference",
    type: "user",
    scope: "user",
    content: "Always use pnpm.",
    tags: [],
    schemaVersion: 1,
    sourceRefs: [],
    status: "active",
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
}

function application(): MemoryApplicationFacade {
  return {
    remember: vi.fn(async () => record()),
    write: vi.fn(async () => ({ action: "created" as const, record: record() })),
    update: vi.fn(async () => ({ action: "updated" as const, record: record() })),
    correct: vi.fn(async () => ({ action: "superseded" as const, record: record(), previous: record() })),
    search: vi.fn(() => [record()]),
    read: vi.fn(async () => record()),
    forget: vi.fn(async () => true),
    feedback: vi.fn(async () => record({ type: "feedback", kind: "correction" })),
    inspectContext: vi.fn(() => ({ available: true })),
  };
}

async function execute(pi: ToolPi, name: string, params: unknown, ctx = context()) {
  const definition = pi.tools.get(name);
  if (!definition) throw new Error(`missing tool: ${name}`);
  return definition.execute("call-1", params, undefined, undefined, ctx);
}

describe("Pi native memory tool contract", () => {
  it("registers the Pi-safe memory names and JSON object schemas", () => {
    const pi = new ToolPi();
    registerMemoryTools(pi, application(), createErrorReporter(false));

    expect([...pi.tools.keys()]).toEqual(PI_MEMORY_TOOL_NAMES);
    for (const definition of pi.tools.values()) {
      expect(definition.parameters).toMatchObject({ type: "object", additionalProperties: false });
      expect(Reflect.ownKeys(definition.parameters)).toContain("~kind");
    }
    expect(Check(pi.tools.get("memory_search")!.parameters, { text: "decision", limit: 5 })).toBe(true);
    expect(Check(pi.tools.get("memory_search")!.parameters, { limit: 5 })).toBe(false);
  });

  it("delegates every operation to the shared application facade", async () => {
    const pi = new ToolPi();
    const app = application();
    const ctx = context();
    const projectId = (await resolveProjectIdentity(ctx.cwd)).projectId;
    registerMemoryTools(pi, app, createErrorReporter(false), { userId: "user-1" });

    await execute(pi, "memory_remember", {
      name: "Architecture",
      description: "Project decision",
      content: "Use append-only logs.",
      type: "project",
      scope: "project",
      kind: "decision",
      projectId,
      importance: 0.9,
    });
    await execute(pi, "memory_search", { text: "append-only", scope: "project", projectId, limit: 5 }, ctx);
    await execute(pi, "memory_upsert", {
      name: "Architecture", description: "Project decision", content: "Use append-only logs.",
      type: "project", scope: "project", projectId, idempotencyKey: "call-1",
    }, ctx);
    await execute(pi, "memory_update", {
      name: "Architecture", description: "Updated decision", content: "Use durable append-only logs.",
      type: "project", scope: "project", projectId, targetMemoryId: "memory-1", expectedRevision: 1,
    }, ctx);
    await execute(pi, "memory_correct", {
      name: "Correction", description: "Corrected decision", content: "Use an atomic projection log.",
      scope: "project", projectId, targetMemoryId: "memory-1",
    }, ctx);
    await execute(pi, "memory_read", { scope: "project", id: "memory-1", projectId }, ctx);
    await execute(pi, "memory_forget", { scope: "project", id: "memory-1", projectId }, ctx);
    await execute(pi, "memory_feedback", {
      name: "Correction",
      description: "Use the right command",
      content: "Use pnpm, not npm.",
      scope: "user",
    }, ctx);
    await execute(pi, "context_inspect", {}, ctx);

    expect(app.remember).toHaveBeenCalledWith(expect.objectContaining({ type: "project", kind: "decision" }));
    expect(app.write).toHaveBeenCalledWith(expect.objectContaining({ operation: "upsert", idempotencyKey: "call-1" }));
    expect(app.update).toHaveBeenCalledWith(expect.objectContaining({ targetMemoryId: "memory-1", expectedRevision: 1 }));
    expect(app.correct).toHaveBeenCalledWith(expect.objectContaining({ targetMemoryId: "memory-1", type: "feedback", kind: "correction" }));
    expect(app.search).toHaveBeenCalledWith(expect.objectContaining({ text: "append-only", scope: "project", projectId, limit: 5 }));
    expect(app.read).toHaveBeenCalledWith("project", "memory-1", projectId);
    expect(app.forget).toHaveBeenCalledWith("project", "memory-1", projectId);
    expect(app.feedback).toHaveBeenCalledWith(expect.not.objectContaining({ type: expect.anything(), kind: expect.anything() }));
    expect(app.inspectContext).toHaveBeenCalledWith("session-1");
  });

  it("defaults project scoped tool calls to the active cwd project identity", async () => {
    const pi = new ToolPi();
    const app = application();
    const ctx = context();
    registerMemoryTools(pi, app, createErrorReporter(true));
    const projectId = (await resolveProjectIdentity(ctx.cwd)).projectId;

    const result = await execute(pi, "memory_remember", {
      name: "Decision",
      description: "Default project identity",
      content: "Keep this.",
      type: "project",
      scope: "project",
    }, ctx);

    expect(result.details).toMatchObject({ ok: true });
    expect(app.remember).toHaveBeenCalledWith(expect.objectContaining({ projectId }));
    expect(ctx.ui?.notify).not.toHaveBeenCalled();
  });

  it("rejects a model-supplied project identity outside the active Pi checkout", async () => {
    const pi = new ToolPi();
    const app = application();
    const ctx = context();
    registerMemoryTools(pi, app, createErrorReporter(true));

    const remember = await execute(pi, "memory_remember", {
      name: "Escaped memory",
      description: "Must not cross projects",
      content: "Write outside the active project.",
      type: "project",
      scope: "project",
      projectId: "foreign-project",
    }, ctx);
    const search = await execute(pi, "memory_search", {
      text: "outside",
      projectId: "foreign-project",
    }, ctx);
    const forget = await execute(pi, "memory_forget", {
      scope: "project",
      id: "memory-1",
      projectId: "foreign-project",
    }, ctx);
    const read = await execute(pi, "memory_read", {
      scope: "project",
      id: "memory-1",
      projectId: "foreign-project",
    }, ctx);

    expect(remember).toMatchObject({ details: { ok: false, error: "projectId must match the active Pi project" } });
    expect(search).toMatchObject({ details: { ok: false, error: "projectId must match the active Pi project" } });
    expect(forget).toMatchObject({ details: { ok: false, error: "projectId must match the active Pi project" } });
    expect(read).toMatchObject({ details: { ok: false, error: "projectId must match the active Pi project" } });
    expect(app.remember).not.toHaveBeenCalled();
    expect(app.search).not.toHaveBeenCalled();
    expect(app.forget).not.toHaveBeenCalled();
    expect(app.read).not.toHaveBeenCalled();
  });

  it.each(["user", "agent", "team"] as const)(
    "rejects every native memory operation for %s scope without a stable host identity",
    async (scope) => {
      const pi = new ToolPi();
      const app = application();
      registerMemoryTools(pi, app, createErrorReporter(false));
      const common = {
        name: "Scoped memory",
        description: "Must remain isolated",
        content: "Scoped content",
        type: "project",
        scope,
      };
      const calls: Array<[string, Record<string, unknown>]> = [
        ["memory_remember", common],
        ["memory_upsert", common],
        ["memory_update", { ...common, targetMemoryId: "memory-1" }],
        ["memory_correct", { ...common, targetMemoryId: "memory-1" }],
        ["memory_search", { text: "scoped", scope }],
        ["memory_read", { scope, id: "memory-1" }],
        ["memory_forget", { scope, id: "memory-1" }],
        ["memory_feedback", {
          name: common.name,
          description: common.description,
          content: common.content,
          scope,
        }],
      ];

      for (const [name, params] of calls) {
        const result = await execute(pi, name, params);
        expect(result).toMatchObject({
          details: { ok: false, error: expect.stringContaining(`stable ${scope === "team" ? "teamId" : `${scope}Id`}`) },
        });
      }
      expect(app.remember).not.toHaveBeenCalled();
      expect(app.write).not.toHaveBeenCalled();
      expect(app.update).not.toHaveBeenCalled();
      expect(app.correct).not.toHaveBeenCalled();
      expect(app.search).not.toHaveBeenCalled();
      expect(app.read).not.toHaveBeenCalled();
      expect(app.forget).not.toHaveBeenCalled();
      expect(app.feedback).not.toHaveBeenCalled();
    },
  );

  it("derives user, agent, and team partitions only from trusted adapter configuration", async () => {
    const pi = new ToolPi();
    const app = application();
    registerMemoryTools(pi, app, createErrorReporter(false), {
      userId: "user-42",
      agentId: "agent-7",
      teamId: "team-blue",
    });

    for (const scope of ["user", "agent", "team"] as const) {
      const result = await execute(pi, "memory_remember", {
        name: `${scope} memory`,
        description: "Stable partition",
        content: "Scoped content",
        type: "project",
        scope,
      });
      expect(result).toMatchObject({ details: { ok: true } });
    }

    expect(app.remember).toHaveBeenNthCalledWith(1, expect.objectContaining({
      scope: "user", partition: { schemaVersion: 1, userId: "user-42" },
    }));
    expect(app.remember).toHaveBeenNthCalledWith(2, expect.objectContaining({
      scope: "agent", partition: { schemaVersion: 1, agentId: "agent-7" },
    }));
    expect(app.remember).toHaveBeenNthCalledWith(3, expect.objectContaining({
      scope: "team", partition: expect.objectContaining({ schemaVersion: 1, teamId: "team-blue" }),
    }));
  });

  it("validates input before invoking the application", async () => {
    const pi = new ToolPi();
    const app = application();
    const ctx = context();
    registerMemoryTools(pi, app, createErrorReporter(true));

    const result = await execute(pi, "memory_remember", {
      name: "Decision",
      description: "Invalid scope",
      content: "Keep this.",
      type: "project",
      scope: "organization",
    }, ctx);

    expect(result.details).toEqual({ ok: false, error: "scope is invalid" });
    expect(app.remember).not.toHaveBeenCalled();
    expect(ctx.ui?.notify).toHaveBeenCalledOnce();
  });

  it("fails open when the application rejects and returns an observable tool result", async () => {
    const pi = new ToolPi();
    const app = application();
    app.search = vi.fn(() => { throw new Error("index offline"); });
    const ctx = context();
    registerMemoryTools(pi, app, createErrorReporter(true));

    await expect(execute(pi, "memory_search", { text: "decision" }, ctx)).resolves.toMatchObject({
      details: { ok: false, error: "index offline" },
    });
    expect(ctx.ui?.notify).toHaveBeenCalledWith(expect.stringContaining("index offline"), "warning");
  });

  it("does not expose unusable tools without an application service", () => {
    const pi = new ToolPi();
    registerMemoryTools(pi, undefined, createErrorReporter(false));
    expect(pi.tools.size).toBe(0);
  });
});
