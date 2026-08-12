import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";

/** Configuration file version independently evolved from durable data schemas. */
export const AGENTENGRAM_CONFIG_VERSION = 1 as const;

/** Host ownership intent. `auto` always resolves conservatively inside an adapter. */
export type AgentEngramContextMode = "auto" | "enhance" | "managed-context";

/** Provider-neutral model selection policy for one Runtime task family. */
export interface AgentEngramModelTaskConfig {
  readonly strategy?: "host-current" | "configured-provider" | "disabled";
  readonly fallback?: "configured-provider" | "disabled";
}

/** Credential-free provider profile. Secrets are referenced by environment variable name only. */
export interface AgentEngramProviderConfig {
  /** Provider protocol. V1 supports the OpenAI-compatible chat-completions contract. */
  readonly type?: "openai-compatible";
  readonly baseUrl?: string;
  readonly model?: string;
  readonly apiKeyEnv?: string;
}

/** Versioned user/project configuration shared by Engine administration and adapters. */
export interface AgentEngramConfig {
  readonly schemaVersion: typeof AGENTENGRAM_CONFIG_VERSION;
  readonly dataDir?: string;
  readonly context?: {
    readonly defaultMode?: AgentEngramContextMode;
    readonly failOpen?: boolean;
  };
  readonly models?: {
    readonly compact?: AgentEngramModelTaskConfig;
    readonly formation?: AgentEngramModelTaskConfig;
  };
  readonly provider?: AgentEngramProviderConfig;
  readonly identities?: {
    readonly userId?: string;
    readonly agentId?: string;
    readonly teamId?: string;
  };
  readonly retention?: {
    readonly transcriptDays?: number;
  };
  readonly adapters?: {
    readonly pi?: {
      readonly mode?: AgentEngramContextMode;
      readonly models?: AgentEngramTaskSetConfig;
    };
    readonly codex?: {
      readonly mode?: "auto" | "enhance";
      readonly models?: AgentEngramTaskSetConfig;
    };
  };
}

/** Compact/formation policies reusable at global or adapter-specific level. */
export interface AgentEngramTaskSetConfig {
  readonly compact?: AgentEngramModelTaskConfig;
  readonly formation?: AgentEngramModelTaskConfig;
}

/** Fully validated configuration plus the ordered files that contributed values. */
export interface LoadedAgentEngramConfig {
  readonly config: AgentEngramConfig;
  readonly sources: readonly string[];
  readonly userConfigPath: string;
  readonly projectConfigPath: string;
}

export interface LoadAgentEngramConfigOptions {
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly userConfigPath?: string;
  readonly projectConfigPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Loads user then project configuration and finally applies environment
 * overrides. Merge order is deterministic and secret values never enter the
 * returned object; provider credentials remain environment references.
 */
export async function loadAgentEngramConfig(options: LoadAgentEngramConfigOptions = {}): Promise<LoadedAgentEngramConfig> {
  const environment = options.environment ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const dataDir = resolve(options.homeDir ?? environment.AGENTENGRAM_HOME ?? join(homedir(), ".agentengram"));
  const userConfigPath = resolve(options.userConfigPath ?? join(dataDir, "config.json"));
  const projectConfigPath = resolve(options.projectConfigPath ?? join(cwd, ".agentengram", "config.json"));
  const sources: string[] = [];
  let merged: Record<string, unknown> = mergeRecords({ schemaVersion: 1 }, environmentOverrides(environment, dataDir));
  for (const path of [userConfigPath, projectConfigPath]) {
    const value = await readOptionalConfig(path);
    if (!value) continue;
    merged = mergeRecords(merged, value);
    sources.push(path);
  }
  return { config: validateAgentEngramConfig(merged), sources, userConfigPath, projectConfigPath };
}

/** Synchronous variant for host extension factories that must register hooks during module load. */
export function loadAgentEngramConfigSync(options: LoadAgentEngramConfigOptions = {}): LoadedAgentEngramConfig {
  const environment = options.environment ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const dataDir = resolve(options.homeDir ?? environment.AGENTENGRAM_HOME ?? join(homedir(), ".agentengram"));
  const userConfigPath = resolve(options.userConfigPath ?? join(dataDir, "config.json"));
  const projectConfigPath = resolve(options.projectConfigPath ?? join(cwd, ".agentengram", "config.json"));
  const sources: string[] = [];
  let merged: Record<string, unknown> = mergeRecords({ schemaVersion: 1 }, environmentOverrides(environment, dataDir));
  for (const path of [userConfigPath, projectConfigPath]) {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    try {
      merged = mergeRecords(merged, record(JSON.parse(content) as unknown, `AgentEngram config ${path}`));
      sources.push(path);
    } catch (error) {
      throw new Error(`cannot load ${path}: ${errorMessage(error)}`);
    }
  }
  return { config: validateAgentEngramConfig(merged), sources, userConfigPath, projectConfigPath };
}

/** Validates untrusted JSON and normalizes optional strings and retention bounds. */
export function validateAgentEngramConfig(value: unknown): AgentEngramConfig {
  const root = record(value, "AgentEngram config");
  assertKnownKeys(root, "AgentEngram config", ["schemaVersion", "dataDir", "context", "models", "provider", "identities", "retention", "adapters"]);
  if (root.schemaVersion !== 1) throw new Error("AgentEngram config schemaVersion must be 1");
  const context = optionalRecord(root.context, "context");
  const models = optionalRecord(root.models, "models");
  const compact = optionalRecord(models?.compact, "models.compact");
  const formation = optionalRecord(models?.formation, "models.formation");
  const provider = optionalRecord(root.provider, "provider");
  const identities = optionalRecord(root.identities, "identities");
  const retention = optionalRecord(root.retention, "retention");
  const adapters = optionalRecord(root.adapters, "adapters");
  const pi = optionalRecord(adapters?.pi, "adapters.pi");
  const codex = optionalRecord(adapters?.codex, "adapters.codex");
  const piModels = optionalRecord(pi?.models, "adapters.pi.models");
  const codexModels = optionalRecord(codex?.models, "adapters.codex.models");
  const piCompact = optionalRecord(piModels?.compact, "adapters.pi.models.compact");
  const piFormation = optionalRecord(piModels?.formation, "adapters.pi.models.formation");
  const codexCompact = optionalRecord(codexModels?.compact, "adapters.codex.models.compact");
  const codexFormation = optionalRecord(codexModels?.formation, "adapters.codex.models.formation");
  if (context) assertKnownKeys(context, "context", ["defaultMode", "failOpen"]);
  if (models) assertKnownKeys(models, "models", ["compact", "formation"]);
  if (compact) assertKnownKeys(compact, "models.compact", ["strategy", "fallback"]);
  if (formation) assertKnownKeys(formation, "models.formation", ["strategy", "fallback"]);
  if (provider) assertKnownKeys(provider, "provider", ["type", "baseUrl", "model", "apiKeyEnv"]);
  if (identities) assertKnownKeys(identities, "identities", ["userId", "agentId", "teamId"]);
  if (retention) assertKnownKeys(retention, "retention", ["transcriptDays"]);
  if (adapters) assertKnownKeys(adapters, "adapters", ["pi", "codex"]);
  if (pi) assertKnownKeys(pi, "adapters.pi", ["mode", "models"]);
  if (codex) assertKnownKeys(codex, "adapters.codex", ["mode", "models"]);
  for (const [name, taskSet, taskCompact, taskFormation] of [
    ["adapters.pi.models", piModels, piCompact, piFormation],
    ["adapters.codex.models", codexModels, codexCompact, codexFormation],
  ] as const) {
    if (taskSet) assertKnownKeys(taskSet, name, ["compact", "formation"]);
    if (taskCompact) assertKnownKeys(taskCompact, `${name}.compact`, ["strategy", "fallback"]);
    if (taskFormation) assertKnownKeys(taskFormation, `${name}.formation`, ["strategy", "fallback"]);
  }
  const transcriptDays = optionalPositiveInteger(retention?.transcriptDays, "retention.transcriptDays");
  const apiKeyEnv = optionalString(provider?.apiKeyEnv, "provider.apiKeyEnv");
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error("provider.apiKeyEnv must be an environment variable name");
  }
  const config: AgentEngramConfig = {
    schemaVersion: 1,
    ...optionalStringProperty(root.dataDir, "dataDir"),
    ...(context ? { context: {
      ...optionalEnumProperty(context.defaultMode, "context.defaultMode", ["auto", "enhance", "managed-context"] as const),
      ...optionalBooleanProperty(context.failOpen, "context.failOpen"),
    } } : {}),
    ...(models ? { models: {
      ...(compact ? { compact: modelTask(compact, "models.compact") } : {}),
      ...(formation ? { formation: modelTask(formation, "models.formation") } : {}),
    } } : {}),
    ...(provider ? { provider: {
      ...optionalEnumProperty(provider.type, "provider.type", ["openai-compatible"] as const),
      ...optionalStringProperty(provider.baseUrl, "baseUrl"),
      ...optionalStringProperty(provider.model, "model"),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
    } } : {}),
    ...(identities ? { identities: {
      ...optionalStringProperty(identities.userId, "userId"),
      ...optionalStringProperty(identities.agentId, "agentId"),
      ...optionalStringProperty(identities.teamId, "teamId"),
    } } : {}),
    ...(retention ? { retention: { ...(transcriptDays === undefined ? {} : { transcriptDays }) } } : {}),
    ...(adapters ? { adapters: {
      ...(pi ? { pi: {
        ...optionalEnumProperty(pi.mode, "adapters.pi.mode", ["auto", "enhance", "managed-context"] as const),
        ...(piModels ? { models: taskSet(piModels, "adapters.pi.models") } : {}),
      } } : {}),
      ...(codex ? { codex: {
        ...optionalEnumProperty(codex.mode, "adapters.codex.mode", ["auto", "enhance"] as const),
        ...(codexModels ? { models: taskSet(codexModels, "adapters.codex.models") } : {}),
      } } : {}),
    } } : {}),
  };
  return config;
}

/** Produces a conservative adapter-specific project file without credentials. */
export function initialAgentEngramConfig(adapter: "pi" | "codex"): AgentEngramConfig {
  if (adapter === "pi") {
    return {
      schemaVersion: 1,
      context: { defaultMode: "enhance", failOpen: true },
      adapters: { pi: {
        mode: "enhance",
        models: {
          compact: { strategy: "host-current", fallback: "disabled" },
          formation: { strategy: "host-current", fallback: "disabled" },
        },
      } },
    };
  }
  return {
    schemaVersion: 1,
    context: { defaultMode: "enhance", failOpen: true },
    adapters: { codex: {
      mode: "enhance",
      models: {
        compact: { strategy: "disabled", fallback: "disabled" },
        formation: { strategy: "disabled", fallback: "disabled" },
      },
    } },
  };
}

/** Deep-merges two validated files while preserving the override's leaf values. */
export function mergeAgentEngramConfig(base: AgentEngramConfig, override: AgentEngramConfig): AgentEngramConfig {
  return validateAgentEngramConfig(mergeRecords(base as unknown as Record<string, unknown>, override as unknown as Record<string, unknown>));
}

/** Atomically writes a validated configuration, refusing accidental overwrite. */
export async function writeAgentEngramConfig(path: string, config: AgentEngramConfig, overwrite = false): Promise<void> {
  const validated = validateAgentEngramConfig(config);
  if (!overwrite && await exists(path)) throw new Error(`AgentEngram config already exists: ${path}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

function modelTask(value: Record<string, unknown>, path: string): AgentEngramModelTaskConfig {
  return {
    ...optionalEnumProperty(value.strategy, `${path}.strategy`, ["host-current", "configured-provider", "disabled"] as const),
    ...optionalEnumProperty(value.fallback, `${path}.fallback`, ["configured-provider", "disabled"] as const),
  };
}

function taskSet(value: Record<string, unknown>, path: string): AgentEngramTaskSetConfig {
  const compact = optionalRecord(value.compact, `${path}.compact`);
  const formation = optionalRecord(value.formation, `${path}.formation`);
  return {
    ...(compact ? { compact: modelTask(compact, `${path}.compact`) } : {}),
    ...(formation ? { formation: modelTask(formation, `${path}.formation`) } : {}),
  };
}

function environmentOverrides(environment: Readonly<Record<string, string | undefined>>, dataDir: string): Record<string, unknown> {
  // Provider activation is intentionally namespaced. A commonly used provider
  // credential such as DASHSCOPE_API_KEY may exist for unrelated applications;
  // discovering it must never opt AgentEngram into model calls implicitly.
  const apiKeyEnv = environment.AGENTENGRAM_LLM_API_KEY_ENV?.trim();
  const baseUrl = environment.AGENTENGRAM_LLM_BASE_URL?.trim();
  const model = environment.AGENTENGRAM_LLM_MODEL?.trim();
  const hasProviderOverride = Boolean(apiKeyEnv || baseUrl || model);
  return {
    schemaVersion: 1,
    dataDir,
    ...(hasProviderOverride ? {
      provider: {
        type: "openai-compatible",
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {}),
        ...(apiKeyEnv ? { apiKeyEnv } : {}),
      },
    } : {}),
    identities: {
      ...(environment.AGENTENGRAM_USER_ID?.trim() ? { userId: environment.AGENTENGRAM_USER_ID.trim() } : {}),
      ...(environment.AGENTENGRAM_AGENT_ID?.trim() ? { agentId: environment.AGENTENGRAM_AGENT_ID.trim() } : {}),
      ...(environment.AGENTENGRAM_TEAM_ID?.trim() ? { teamId: environment.AGENTENGRAM_TEAM_ID.trim() } : {}),
    },
  };
}

async function readOptionalConfig(path: string): Promise<Record<string, unknown> | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    return record(JSON.parse(content) as unknown, `AgentEngram config ${path}`);
  } catch (error) {
    throw new Error(`cannot load ${path}: ${errorMessage(error)}`);
  }
}

function mergeRecords(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prior = output[key];
    output[key] = isRecord(prior) && isRecord(value) ? mergeRecords(prior, value) : value;
  }
  return output;
}

function optionalStringProperty(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return { [name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name]: value.trim() };
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalBooleanProperty(value: unknown, name: string): Record<string, boolean> {
  if (value === undefined) return {};
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return { [name.slice(name.lastIndexOf(".") + 1)]: value };
}

function optionalEnumProperty<const T extends readonly string[]>(value: unknown, name: string, allowed: T): Partial<Record<string, T[number]>> {
  if (value === undefined) return {};
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return { [name.slice(name.lastIndexOf(".") + 1)]: value as T[number] };
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

function optionalRecord(value: unknown, name: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : record(value, name);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function assertKnownKeys(value: Record<string, unknown>, name: string, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${name} contains unknown field: ${unknown.join(", ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(() => true).catch((error: unknown) => isMissing(error) ? false : Promise.reject(error));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
