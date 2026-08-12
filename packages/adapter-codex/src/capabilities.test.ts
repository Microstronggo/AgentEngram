import { readFile } from "node:fs/promises";
import { assertAdapterCompatibilityDescriptor, assertAdapterConformance } from "@agentengram/engine/testing";
import { describe, expect, it } from "vitest";
import { CODEX_CAPABILITIES, resolveCodexMode } from "./capabilities.js";
import { CODEX_ADAPTER_COMPATIBILITY } from "./compatibility.js";
import { CODEX_HOOK_EVENTS, CODEX_HOOK_REQUIRED_FIELDS } from "./types.js";
import { validateCodexHookInput } from "./hook-runtime.js";

describe("Codex adapter capabilities", () => {
  it("publishes concrete upstream compatibility evidence", () => {
    expect(() => assertAdapterCompatibilityDescriptor(CODEX_ADAPTER_COMPATIBILITY)).not.toThrow();
    expect(CODEX_ADAPTER_COMPATIBILITY.integrationSchema).toBe(CODEX_CAPABILITIES.schemaVersion);
  });
  it("resolves auto conservatively to enhance", () => {
    expect(resolveCodexMode()).toBe("enhance");
    expect(resolveCodexMode("enhance")).toBe("enhance");
    expect(CODEX_CAPABILITIES).toMatchObject({
      replaceContext: false,
      replaceCompaction: false,
      transcriptMode: "jsonl-rollout",
      canInvokeCurrentModel: false,
      runtimeLifetime: "command-hook",
      supportsSubagents: true,
      toolLifecycle: false,
    });
  });

  it("rejects managed-context instead of silently downgrading", () => {
    expect(() => resolveCodexMode("managed-context")).toThrow(/cannot replace model context/u);
  });

  it("keeps installed Hook coverage consistent with declared active capabilities", async () => {
    const configuration = JSON.parse(await readFile(
      new URL("../hooks/hooks.json", import.meta.url),
      "utf8",
    )) as { hooks: Record<string, unknown> };
    const installed = Object.keys(configuration.hooks);
    expect(installed).toEqual(expect.arrayContaining([
      "SessionStart",
      "UserPromptSubmit",
      "PreCompact",
      "PostCompact",
      "SubagentStart",
      "SubagentStop",
      "Stop",
    ]));
    expect(installed).not.toEqual(expect.arrayContaining(["PreToolUse", "PermissionRequest", "PostToolUse"]));
    expect(CODEX_HOOK_EVENTS).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SubagentStart",
      "SubagentStop",
      "Stop",
    ]);
  });

  it("matches the pinned upstream required-field fixtures and accepts compact without permission mode", async () => {
    const requiredFields = JSON.parse(await readFile(
      new URL("../test/fixtures/codex-hook-required-fields.json", import.meta.url),
      "utf8",
    )) as Record<string, readonly string[]>;
    expect(CODEX_HOOK_REQUIRED_FIELDS).toEqual(requiredFields);

    expect(() => validateCodexHookInput({
      session_id: "session-1",
      turn_id: "turn-1",
      transcript_path: null,
      cwd: "/project",
      hook_event_name: "PreCompact",
      model: "gpt-test",
      trigger: "auto",
    })).not.toThrow();
    expect(() => validateCodexHookInput({
      session_id: "session-1",
      turn_id: "turn-1",
      transcript_path: null,
      cwd: "/project",
      hook_event_name: "PostCompact",
      model: "gpt-test",
      trigger: "auto",
    })).not.toThrow();
  });

  it("passes the shared adapter conformance suite using installed command hooks", async () => {
    const configuration = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url), "utf8")) as {
      hooks: Record<string, unknown>;
    };
    const hooks = new Set(Object.keys(configuration.hooks));
    assertAdapterConformance({
      adapterName: "codex",
      capabilities: CODEX_CAPABILITIES,
      observed: {
        contextHook: hooks.has("UserPromptSubmit"),
        replaceContext: false,
        compactionHook: hooks.has("PreCompact") && hooks.has("PostCompact"),
        replaceCompaction: false,
        sessionLifecycle: hooks.has("SessionStart") && hooks.has("Stop"),
        threadLifecycle: hooks.has("UserPromptSubmit") && hooks.has("Stop"),
        toolLifecycle: hooks.has("PreToolUse") || hooks.has("PostToolUse"),
        persistentCustomEntries: false,
        currentModelInvocation: false,
        subagents: hooks.has("SubagentStart") && hooks.has("SubagentStop"),
      },
      resolveMode: resolveCodexMode,
    });
  });
});
