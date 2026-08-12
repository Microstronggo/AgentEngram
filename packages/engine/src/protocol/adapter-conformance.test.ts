import { describe, expect, it } from "vitest";
import { evaluateAdapterConformance } from "./adapter-conformance.js";
import type { HostCapabilities } from "./capabilities.js";

const capabilities: HostCapabilities = {
  contextHook: true, replaceContext: false, compactionHook: true, replaceCompaction: false,
  sessionLifecycle: true, threadLifecycle: false, toolLifecycle: false, persistentCustomEntries: false,
  transcriptMode: "jsonl-rollout", canInvokeCurrentModel: false, runtimeLifetime: "command-hook",
  supportsSubagents: true, schemaVersion: "fixture-v1",
};

describe("adapter conformance test kit", () => {
  it("accepts honest enhance-only capabilities", () => {
    expect(evaluateAdapterConformance({
      adapterName: "fixture", capabilities,
      observed: {
        contextHook: true, replaceContext: false, compactionHook: true, replaceCompaction: false,
        sessionLifecycle: true, threadLifecycle: false, toolLifecycle: false, persistentCustomEntries: false,
        currentModelInvocation: false, subagents: true,
      },
      resolveMode: (mode) => {
        if (mode === "managed-context") throw new Error("unsupported");
        return "enhance";
      },
    })).toEqual([]);
  });

  it("reports capability lies and silent managed downgrade", () => {
    const issues = evaluateAdapterConformance({
      adapterName: "broken", capabilities,
      observed: {
        contextHook: false, replaceContext: false, compactionHook: true, replaceCompaction: false,
        sessionLifecycle: true, threadLifecycle: false, toolLifecycle: false, persistentCustomEntries: false,
        currentModelInvocation: false, subagents: true,
      },
      resolveMode: () => "enhance",
    });
    expect(issues.map(({ field }) => field)).toEqual(expect.arrayContaining(["contextHook", "managedMode"]));
  });
});
