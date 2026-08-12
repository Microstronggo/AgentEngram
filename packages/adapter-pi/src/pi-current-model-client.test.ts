import { describe, expect, it, vi } from "vitest";
import type { LLMChatClient } from "@agentengram/engine";
import { PiCurrentModelLLMClient, type PiCompletionFunction } from "./pi-current-model-client.js";
import type { PiContext, PiModel, PiModelRegistry } from "./pi-types.js";

const firstModel: PiModel = {
  id: "model-a",
  name: "Model A",
  api: "anthropic-messages",
  provider: "provider-a",
};

const secondModel: PiModel = {
  id: "model-b",
  name: "Model B",
  api: "openai-completions",
  provider: "provider-b",
};

describe("PiCurrentModelLLMClient", () => {
  it("can resolve the Pi completion runtime declared by the adapter peer contract", async () => {
    const piAi = await import("@earendil-works/pi-ai/compat");
    expect(piAi.completeSimple).toBeTypeOf("function");
  });

  it("invokes the observed Pi model with resolved auth and neutral messages", async () => {
    const complete = vi.fn<PiCompletionFunction>(async () => ({
      content: [{ type: "text", text: "formation result" }],
      model: "model-a",
      responseModel: "model-a-202607",
      stopReason: "stop",
      usage: { input: 12, output: 5, totalTokens: 17 },
    }));
    const registry = registryReturning({
      ok: true,
      apiKey: "secret-key",
      headers: { "x-tenant": "tenant-a" },
      env: { REGION: "cn" },
    });
    const client = new PiCurrentModelLLMClient({ complete, now: () => 123 });
    client.observe(context(firstModel, registry));

    const result = await client.chat([
      { role: "system", content: "Return JSON." },
      { role: "user", content: "Extract memory." },
      { role: "assistant", content: "Previous answer." },
    ], { temperature: 0, maxTokens: 500 });

    expect(result).toEqual({
      content: "formation result",
      model: "model-a-202607",
      usage: { input: 12, output: 5, totalTokens: 17 },
    });
    expect(complete).toHaveBeenCalledWith(
      firstModel,
      expect.objectContaining({
        systemPrompt: "Return JSON.",
        messages: [
          { role: "user", content: "Extract memory.", timestamp: 123 },
          expect.objectContaining({ role: "assistant", model: "model-a", timestamp: 123 }),
        ],
      }),
      expect.objectContaining({
        apiKey: "secret-key",
        headers: { "x-tenant": "tenant-a" },
        env: { REGION: "cn" },
        temperature: 0,
        maxTokens: 500,
      }),
    );
    expect(client.lastDecision()).toEqual({
      source: "host-current",
      requestedModel: "provider-a/model-a",
      actualModel: "model-a-202607",
    });
    expect(JSON.stringify(client.lastDecision())).not.toContain("secret-key");
  });

  it("uses a new model for later calls while preserving an in-flight snapshot", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const observed: string[] = [];
    const complete: PiCompletionFunction = async (model) => {
      observed.push(model.id);
      if (model.id === "model-a") await blocked;
      return { content: [{ type: "text", text: model.id }], model: model.id, stopReason: "stop" };
    };
    const registry = registryReturning({ ok: true });
    const client = new PiCurrentModelLLMClient({ complete });
    client.observe(context(firstModel, registry));

    const first = client.chat([{ role: "user", content: "first" }]);
    client.observe(context(secondModel, registry));
    const second = client.chat([{ role: "user", content: "second" }]);
    release();

    await expect(first).resolves.toMatchObject({ content: "model-a" });
    await expect(second).resolves.toMatchObject({ content: "model-b" });
    expect(observed).toEqual(["model-a", "model-b"]);
  });

  it("returns a client bound to a previously captured durable model reference", async () => {
    const observed: string[] = [];
    const complete: PiCompletionFunction = async (model) => {
      observed.push(model.id);
      return { content: [{ type: "text", text: model.id }], model: model.id, stopReason: "stop" };
    };
    const registry = registryReturning({ ok: true });
    const client = new PiCurrentModelLLMClient({ complete });
    client.observe(context(firstModel, registry));
    const reference = client.currentModel();
    client.observe(context(secondModel, registry));

    const bound = client.invokeClient(reference);
    await expect(bound?.chat([{ role: "user", content: "durable job" }]))
      .resolves.toMatchObject({ content: "model-a" });
    expect(observed).toEqual(["model-a"]);
  });

  it("does not replace an unavailable durable reference with the newly selected host model", () => {
    const fallback: LLMChatClient = { chat: async () => ({ content: "fallback", model: "qwen-plus" }) };
    const client = new PiCurrentModelLLMClient({ fallback });
    client.observe(context(secondModel, registryReturning({ ok: true })));

    expect(client.invokeClient({ provider: "provider-a", model: "model-a" })).toBeUndefined();
    expect(client.invokeClient()).toBeDefined();
  });

  it("uses the configured provider only after host-current invocation is unavailable", async () => {
    const fallback: LLMChatClient = {
      chat: vi.fn(async () => ({ content: "fallback", model: "qwen-plus" })),
    };
    const client = new PiCurrentModelLLMClient({ fallback });

    await expect(client.chat([{ role: "user", content: "extract" }])).resolves.toEqual({
      content: "fallback",
      model: "qwen-plus",
    });
    expect(client.lastDecision()).toEqual({
      source: "configured-fallback",
      actualModel: "qwen-plus",
      fallbackReason: "Pi current model is unavailable",
    });
  });

  it("fails explicitly when neither current model nor configured fallback is callable", async () => {
    const client = new PiCurrentModelLLMClient();
    await expect(client.chat([{ role: "user", content: "extract" }]))
      .rejects.toThrow("Pi current model is unavailable");

    client.observe(context(firstModel, registryReturning({ ok: false, error: "auth missing" })));
    await expect(client.chat([{ role: "user", content: "extract" }]))
      .rejects.toThrow("auth missing");
  });
});

function registryReturning(
  result: Awaited<ReturnType<PiModelRegistry["getApiKeyAndHeaders"]>>,
): PiModelRegistry {
  return { getApiKeyAndHeaders: vi.fn(async () => result) };
}

function context(model: PiModel, modelRegistry: PiModelRegistry): PiContext {
  return {
    cwd: "/repo",
    sessionManager: { getSessionFile: () => "/sessions/one.jsonl" },
    model,
    modelRegistry,
  };
}
