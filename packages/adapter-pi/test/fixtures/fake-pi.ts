import { vi } from "vitest";
import type { PiContext, PiEventName, PiExtensionApi, PiHandler, PiToolDefinition } from "../../src/pi-types.js";

export interface FakeBranchEntry {
  readonly id: string;
  readonly type: "message" | "custom";
  readonly message?: unknown;
  readonly customType?: string;
  readonly data?: unknown;
}

export class FakePi implements PiExtensionApi {
  readonly handlers = new Map<PiEventName, PiHandler>();
  readonly tools = new Map<string, PiToolDefinition>();
  readonly entries: Array<{ readonly customType: string; readonly data: unknown }> = [];
  mode: string | undefined;

  on(event: PiEventName, handler: PiHandler): void {
    this.handlers.set(event, handler);
  }

  appendEntry<T>(customType: string, data?: T): void {
    this.entries.push({ customType, data });
  }

  registerTool(tool: PiToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerFlag(_name: string, options: { default: string }): void {
    this.mode = options.default;
  }

  getFlag(): string | undefined {
    return this.mode;
  }

  async emit(event: PiEventName, payload: unknown, context = fakePiContext()): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`No handler for ${event}`);
    return handler(payload, context);
  }

  async executeTool(name: string, params: unknown, context = fakePiContext()): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`No tool registered: ${name}`);
    return tool.execute(`${name}:call`, params, undefined, undefined, context);
  }
}

export function fakePiContext(overrides: Partial<PiContext> & { branch?: readonly FakeBranchEntry[] } = {}): PiContext {
  const branch = overrides.branch;
  return {
    cwd: overrides.cwd ?? "/tmp/agentengram-pi-system",
    sessionManager: {
      getSessionFile: () => overrides.sessionManager?.getSessionFile?.() ?? "/sessions/pi-system.jsonl",
      getSessionId: () => overrides.sessionManager?.getSessionId?.() ?? "pi-session",
      getLeafId: () => overrides.sessionManager?.getLeafId?.() ?? "pi-thread",
      getBranch: () => overrides.sessionManager?.getBranch?.() ?? branch ?? [],
    },
    model: overrides.model ?? {
      id: "fake-current-model",
      api: "openai-completions",
      provider: "test",
    },
    ...(overrides.modelRegistry === undefined ? {} : { modelRegistry: overrides.modelRegistry }),
    getContextUsage: overrides.getContextUsage ?? (() => ({ tokens: 30_000, contextWindow: 32_000, percent: 0.94 })),
    ui: overrides.ui ?? { notify: vi.fn() },
  };
}

export function piTextMessage(id: string, role: "user" | "assistant", text: string): FakeBranchEntry {
  return {
    id,
    type: "message",
    message: { id, role, content: [{ type: "text", text }], timestamp: 1_000 },
  };
}

export function piToolCallMessage(id: string, toolCallId: string, name = "Read"): FakeBranchEntry {
  return {
    id,
    type: "message",
    message: {
      id,
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name, arguments: { path: "README.md" } }],
      timestamp: 1_001,
    },
  };
}

export function piToolResultMessage(id: string, toolCallId: string, output: string): FakeBranchEntry {
  return {
    id,
    type: "message",
    message: {
      id,
      role: "toolResult",
      toolCallId,
      toolName: "Read",
      content: output,
      timestamp: 1_002,
    },
  };
}
