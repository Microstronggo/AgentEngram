import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  initialAgentEngramConfig,
  loadAgentEngramConfig,
  validateAgentEngramConfig,
  writeAgentEngramConfig,
} from "./configuration.js";

describe("AgentEngram configuration", () => {
  it("merges user, project, and credential-free environment overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-config-"));
    const user = join(root, "user.json");
    const project = join(root, "project.json");
    await writeAgentEngramConfig(user, {
      schemaVersion: 1,
      context: { defaultMode: "enhance", failOpen: true },
      provider: { model: "user-model", apiKeyEnv: "CUSTOM_KEY" },
      retention: { transcriptDays: 30 },
    });
    await writeAgentEngramConfig(project, {
      schemaVersion: 1,
      context: { defaultMode: "managed-context" },
      models: { compact: { strategy: "host-current", fallback: "configured-provider" } },
      provider: { model: "project-model" },
    });

    const loaded = await loadAgentEngramConfig({
      cwd: root,
      userConfigPath: user,
      projectConfigPath: project,
      environment: {
        AGENTENGRAM_HOME: join(root, "data"),
        AGENTENGRAM_LLM_MODEL: "environment-model",
        AGENTENGRAM_LLM_API_KEY_ENV: "DASHSCOPE_API_KEY",
        DASHSCOPE_API_KEY: "not-persisted",
      },
    });

    expect(loaded.config).toMatchObject({
      dataDir: join(root, "data"),
      context: { defaultMode: "managed-context", failOpen: true },
      provider: { model: "project-model", apiKeyEnv: "CUSTOM_KEY" },
      retention: { transcriptDays: 30 },
    });
    expect(JSON.stringify(loaded.config)).not.toContain("not-persisted");
    expect(loaded.sources).toEqual([user, project]);
  });

  it("does not activate a provider from an unrelated provider credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-config-provider-"));
    const loaded = await loadAgentEngramConfig({
      cwd: root,
      userConfigPath: join(root, "missing-user.json"),
      projectConfigPath: join(root, "missing-project.json"),
      environment: {
        AGENTENGRAM_HOME: join(root, "data"),
        DASHSCOPE_API_KEY: "must-not-enable-agentengram",
        QWEN_MODEL: "must-not-select-a-model",
      },
    });

    expect(loaded.config.provider).toBeUndefined();
  });

  it("creates conservative Pi and Codex defaults", () => {
    expect(initialAgentEngramConfig("pi")).toMatchObject({
      adapters: { pi: {
        mode: "enhance",
        models: { compact: { strategy: "host-current" }, formation: { strategy: "host-current" } },
      } },
    });
    expect(initialAgentEngramConfig("codex")).toMatchObject({
      adapters: { codex: {
        mode: "enhance",
        models: { compact: { strategy: "disabled" }, formation: { strategy: "disabled" } },
      } },
    });
    expect(initialAgentEngramConfig("pi").provider).toBeUndefined();
    expect(initialAgentEngramConfig("codex").provider).toBeUndefined();
  });

  it("accepts a provider-neutral OpenAI-compatible profile without persisting a credential", () => {
    const config = validateAgentEngramConfig({
      schemaVersion: 1,
      provider: {
        type: "openai-compatible",
        baseUrl: "https://llm.example.test/v1",
        model: "test-model",
        apiKeyEnv: "CUSTOM_LLM_KEY",
      },
    });
    expect(config.provider).toEqual({
      type: "openai-compatible",
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      apiKeyEnv: "CUSTOM_LLM_KEY",
    });
  });

  it("rejects unsupported modes and refuses accidental overwrite", async () => {
    expect(() => validateAgentEngramConfig({ schemaVersion: 1, adapters: { codex: { mode: "managed-context" } } }))
      .toThrow("adapters.codex.mode");
    const root = await mkdtemp(join(tmpdir(), "agentengram-config-"));
    const path = join(root, "config.json");
    await writeAgentEngramConfig(path, initialAgentEngramConfig("pi"));
    await expect(writeAgentEngramConfig(path, initialAgentEngramConfig("codex"))).rejects.toThrow("already exists");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ adapters: { pi: { mode: "enhance" } } });
  });
});
