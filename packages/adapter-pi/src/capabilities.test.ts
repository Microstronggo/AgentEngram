import { assertAdapterCompatibilityDescriptor, assertAdapterConformance } from "@agentengram/engine/testing";
import { describe, expect, it } from "vitest";
import { FakePi } from "../test/fixtures/fake-pi.js";
import { createPiExtension } from "./extension.js";
import { resolveMode } from "./config.js";
import { PI_HOST_CAPABILITIES } from "./capabilities.js";
import { PI_ADAPTER_COMPATIBILITY } from "./compatibility.js";
import type { EngineFacade, IntegrationMode } from "./types.js";

describe("Pi host capability contract", () => {
  it("publishes concrete upstream compatibility evidence", () => {
    expect(() => assertAdapterCompatibilityDescriptor(PI_ADAPTER_COMPATIBILITY)).not.toThrow();
    expect(PI_ADAPTER_COMPATIBILITY.integrationSchema).toBe(PI_HOST_CAPABILITIES.schemaVersion);
  });
  it("declares only the replacement and lifecycle surfaces used by the adapter", () => {
    expect(PI_HOST_CAPABILITIES).toEqual(expect.objectContaining({
      transcriptMode: "branch",
      contextHook: true,
      replaceContext: true,
      compactionHook: true,
      replaceCompaction: true,
      canInvokeCurrentModel: true,
      runtimeLifetime: "long-lived",
      sessionLifecycle: true,
      threadLifecycle: true,
      toolLifecycle: true,
      persistentCustomEntries: true,
      supportsSubagents: false,
    }));
    expect(Object.isFrozen(PI_HOST_CAPABILITIES)).toBe(true);
  });

  it("passes the shared adapter conformance suite using real registered hooks", () => {
    const pi = new FakePi();
    const engine = {
      managedContextReady: true,
      buildManagedContext: async () => ({ messages: [] }),
      compact: async () => undefined,
      createCheckpoint: async () => undefined,
      restoreCheckpoint: async () => ({ status: "unavailable" as const }),
      rebuildFromCanonical: async () => ({ status: "rebuilt" as const }),
      observeHostContext: () => undefined,
    } satisfies EngineFacade;
    createPiExtension({ engine })(pi);
    const hooks = pi.handlers;
    assertAdapterConformance({
      adapterName: "pi",
      capabilities: PI_HOST_CAPABILITIES,
      observed: {
        contextHook: hooks.has("context"),
        replaceContext: hooks.has("context") && engine.managedContextReady,
        compactionHook: hooks.has("session_before_compact") && hooks.has("session_compact"),
        replaceCompaction: hooks.has("session_before_compact") && engine.managedContextReady,
        sessionLifecycle: hooks.has("session_start") && hooks.has("session_shutdown"),
        threadLifecycle: hooks.has("session_before_tree") && hooks.has("session_tree"),
        toolLifecycle: hooks.has("tool_call") && hooks.has("tool_result"),
        persistentCustomEntries: typeof pi.appendEntry === "function",
        currentModelInvocation: hooks.has("model_select") && typeof engine.observeHostContext === "function",
        subagents: false,
      },
      resolveMode: (intent) => {
        pi.mode = intent;
        return resolveMode(pi, intent as IntegrationMode, true);
      },
    });
  });
});
