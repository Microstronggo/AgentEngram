import { describe, expect, it, vi } from "vitest";
import type { LLMChatClient } from "./llm-client.js";
import { DefaultTaskModelResolver } from "./task-model-resolver.js";

const client: LLMChatClient = {
  chat: async () => ({ content: "ok", model: "test-model" }),
};

describe("DefaultTaskModelResolver", () => {
  it("uses an invokable host-current model by default", async () => {
    const hostResolve = vi.fn(() => ({ client, provider: "pi-provider", model: "current-model" }));
    const configuredResolve = vi.fn(() => ({ client, provider: "dashscope", model: "qwen-plus" }));
    const resolver = new DefaultTaskModelResolver({
      hostCurrent: { resolve: hostResolve },
      configured: { resolve: configuredResolve },
    });

    await expect(resolver.resolve("memory-formation", { canInvokeCurrentModel: true })).resolves.toMatchObject({
      requestedSource: "host-current",
      source: "host-current",
      model: "current-model",
    });
    expect(hostResolve).toHaveBeenCalledOnce();
    expect(configuredResolve).not.toHaveBeenCalled();
  });

  it("records configured-provider fallback when the host model cannot be invoked", async () => {
    const hostResolve = vi.fn(() => ({ client, model: "unreachable" }));
    const resolver = new DefaultTaskModelResolver({
      hostCurrent: { resolve: hostResolve },
      configured: { resolve: () => ({ client, provider: "dashscope", model: "qwen-plus" }) },
    });

    await expect(resolver.resolve("compact", { hostType: "codex", canInvokeCurrentModel: false })).resolves.toMatchObject({
      requestedSource: "host-current",
      source: "configured-provider",
      fallbackReason: "host-current-unavailable",
      model: "qwen-plus",
    });
    expect(hostResolve).not.toHaveBeenCalled();
  });

  it("honors explicit configured and disabled task policies", async () => {
    const hostResolve = vi.fn(() => ({ client, model: "current-model" }));
    const configuredResolve = vi.fn(() => ({ client, model: "formation-model" }));
    const resolver = new DefaultTaskModelResolver({
      taskSources: { "memory-formation": "configured-provider", evaluation: "disabled" },
      hostCurrent: { resolve: hostResolve },
      configured: { resolve: configuredResolve },
    });

    await expect(resolver.resolve("memory-formation", { canInvokeCurrentModel: true })).resolves.toMatchObject({
      requestedSource: "configured-provider",
      source: "configured-provider",
      model: "formation-model",
    });
    await expect(resolver.resolve("evaluation", { canInvokeCurrentModel: true })).resolves.toBeUndefined();
    expect(configuredResolve).toHaveBeenCalledOnce();
    expect(hostResolve).not.toHaveBeenCalled();
  });

  it("can require host-current instead of falling back", async () => {
    const configuredResolve = vi.fn(() => ({ client, model: "fallback" }));
    const resolver = new DefaultTaskModelResolver({
      configured: { resolve: configuredResolve },
      allowConfiguredFallback: false,
    });
    await expect(resolver.resolve("collapse", { canInvokeCurrentModel: false })).resolves.toBeUndefined();
    expect(configuredResolve).not.toHaveBeenCalled();
  });
});
