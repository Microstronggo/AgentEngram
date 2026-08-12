import { describe, expect, it } from "vitest";
import { ContextPipeline } from "./context-pipeline.js";
import { projector } from "./context-projector.js";
import type { AgentMessage, ContextRequest, FrameworkCapabilities } from "../protocol/index.js";

const capabilities: FrameworkCapabilities = {
  contextHook: true,
  replaceContext: true,
  compactionHook: true,
  replaceCompaction: true,
  sessionLifecycle: true,
  threadLifecycle: true,
  toolLifecycle: true,
  persistentCustomEntries: true,
};

const canonical = [message("canonical", "canonical")];
const framework = [message("framework", "framework")];

function message(id: string, text: string): AgentMessage {
  return { id, role: "user", content: [{ type: "text", text }] };
}

function request(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    requestId: "request-1",
    sessionId: "session-1",
    threadId: "thread-1",
    canonicalMessages: canonical,
    frameworkMessages: framework,
    capabilities,
    ...overrides,
  };
}

describe("ContextPipeline", () => {
  it("defaults to enhance and preserves the framework-selected context", async () => {
    const view = await new ContextPipeline().build(request());

    expect(view.mode).toBe("enhance");
    expect(view.source).toBe("framework");
    expect(view.messages).toBe(framework);
  });

  it("projects the canonical transcript in managed-context mode", async () => {
    const projection = projector(({ messages }) => [...messages, message("memory", "remembered")]);
    const view = await new ContextPipeline({
      mode: "managed-context",
      projectors: [projection],
    }).build(request());

    expect(view.source).toBe("agentengram");
    expect(view.messages.map(({ id }) => id)).toEqual(["canonical", "memory"]);
  });

  it("fails open to framework context when projection fails", async () => {
    const projection = projector(() => {
      throw new Error("projection failed");
    });
    const view = await new ContextPipeline({ projectors: [projection] }).build(request());

    expect(view.source).toBe("fail-open");
    expect(view.messages).toBe(framework);
    expect(view.failure?.message).toBe("projection failed");
  });

  it("fails open when managed mode is unsupported", async () => {
    const view = await new ContextPipeline({ mode: "managed-context" }).build(request({
      capabilities: { ...capabilities, replaceContext: false },
    }));

    expect(view.source).toBe("fail-open");
    expect(view.messages).toBe(framework);
  });
});

it("fails open when a managed projector leaves an orphan tool result", async () => {
  const pipeline = new ContextPipeline({
    mode: "managed-context",
    projectors: [{
      project: async () => [{
        id: "result",
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "missing", output: "x" }],
      }],
    }],
  });
  const input = request({ mode: "managed-context" });
  const view = await pipeline.build(input);
  expect(view.source).toBe("fail-open");
  expect(view.messages).toBe(input.frameworkMessages);
});
