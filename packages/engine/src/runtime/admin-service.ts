import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import {
  initialAgentEngramConfig,
  loadAgentEngramConfig,
  mergeAgentEngramConfig,
  validateAgentEngramConfig,
  writeAgentEngramConfig,
  type AgentEngramConfig,
} from "../configuration.js";
import { MarkdownMemoryStore, SqliteFtsMemoryIndex, type MemoryScope } from "../memory/index.js";
import { createHostBinding, type HostBinding } from "../protocol/index.js";
import {
  ensureDataLayout,
  inspectDataLayout,
  migrateDataLayout,
  projectRuntimeRoot,
  projectStorageRoot,
  resolveProjectIdentity,
  exportPortableBundle,
  importPortableBundle,
  FileHostBindingRepository,
  storagePathSegment,
  type ExportPortableBundleOptions,
  type ImportPortableBundleOptions,
  type DataMigrationResult,
  type ProjectIdentity,
} from "../storage/index.js";
import {
  TranscriptStore,
  decodeNormalizedTranscriptEntry,
  decodeRawTranscriptRecord,
  type TranscriptVerification,
} from "../transcript/index.js";
import type { DurableMemoryJob, DurableJobStatus } from "./durable-job-runtime.js";

/** Shared location input for CLI diagnostics and adapter support tooling. */
export interface AdminLocationOptions {
  readonly homeDir?: string;
  readonly cwd?: string;
  readonly projectId?: string;
}

/** One independently actionable doctor result. */
export interface DoctorCheck {
  readonly name: string;
  readonly status: "ok" | "warning" | "error";
  readonly message: string;
}

/** Read-only support snapshot that never includes transcript or memory content. */
export interface AgentEngramInspection {
  readonly homeDir: string;
  readonly project: ProjectIdentity;
  readonly layout: Awaited<ReturnType<typeof inspectDataLayout>>;
  readonly memoryRecords: number;
  readonly transcriptSessions: number;
  readonly jobs: Readonly<Record<DurableJobStatus, number>>;
}

/** Explicit deletion plan returned for both dry-run and confirmed execution. */
export interface AgentEngramPurgeResult {
  readonly projectId: string;
  readonly sessionId?: string;
  readonly dryRun: boolean;
  readonly deletedPaths: readonly string[];
  readonly removedBindings: number;
  readonly removedBlobs: number;
}

/**
 * Operational boundary used by `agentengram` CLI commands. It keeps support
 * operations out of adapters while reusing Engine's canonical storage paths.
 */
export class AgentEngramAdminService {
  readonly homeDir: string;
  private readonly cwd: string;
  private readonly explicitProjectId: string | undefined;
  private readonly explicitHomeDir: boolean;

  public constructor(options: AdminLocationOptions = {}) {
    this.explicitHomeDir = options.homeDir !== undefined;
    this.homeDir = options.homeDir ?? process.env.AGENTENGRAM_HOME ?? join(homedir(), ".agentengram");
    this.cwd = options.cwd ?? process.cwd();
    this.explicitProjectId = options.projectId;
  }

  /** Performs read-only environment, schema, project, and projection checks. */
  async doctor(adapter?: "pi" | "codex"): Promise<readonly DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const [major, minor] = process.versions.node.split(".").map(Number);
    checks.push({
      name: "node",
      status: major! > 22 || (major === 22 && minor! >= 5) ? "ok" : "error",
      message: `Node ${process.versions.node}; AgentEngram requires >=22.5.0`,
    });
    try {
      const layout = await inspectDataLayout(this.homeDir);
      checks.push({
        name: "data-layout",
        status: layout.status === "unsupported" ? "error" : layout.status === "current" ? "ok" : "warning",
        message: layout.status === "current" ? "schemaVersion 1"
          : layout.status === "unsupported" ? layout.reason
          : `${layout.status} root; run agentengram migrate`,
      });
    } catch (error) {
      checks.push({ name: "data-layout", status: "error", message: errorMessage(error) });
    }
    let project: ProjectIdentity | undefined;
    try {
      project = await this.project();
      checks.push({ name: "project-identity", status: "ok", message: `${project.projectId} (${project.identityRoot})` });
    } catch (error) {
      checks.push({ name: "project-identity", status: "error", message: errorMessage(error) });
    }
    checks.push(sqliteCheck());
    checks.push(await pathCheck("home-readable", this.homeDir));
    try {
      const loaded = await loadAgentEngramConfig({ cwd: this.cwd, homeDir: this.homeDir });
      checks.push({
        name: "configuration",
        status: loaded.sources.length > 0 ? "ok" : "warning",
        message: loaded.sources.length > 0 ? loaded.sources.join(", ") : "no config file; run agentengram init pi|codex",
      });
      if (adapter) {
        checks.push(adapterConfigurationCheck(adapter, loaded.config));
        checks.push(hostExecutableCheck(adapter));
        checks.push(providerConfigurationCheck(adapter, loaded.config));
      }
    } catch (error) {
      checks.push({ name: "configuration", status: "error", message: errorMessage(error) });
    }
    if (project) {
      const deadLetters = jobCounts(this.jobsPath(project.projectId)).dead_letter;
      checks.push({
        name: "background-jobs",
        status: deadLetters > 0 ? "warning" : "ok",
        message: deadLetters > 0 ? `${deadLetters} dead-letter job(s); inspect with agentengram jobs list --status dead_letter` : "no dead-letter jobs",
      });
    }
    return checks;
  }

  /** Returns the merged credential-free configuration used by adapters. */
  async effectiveConfig() {
    const loaded = await loadAgentEngramConfig({ cwd: this.cwd, homeDir: this.homeDir });
    return { config: loaded.config, sources: loaded.sources };
  }

  /** Initializes durable layout and conservative adapter config in one idempotent workflow. */
  async setupAdapter(adapter: "pi" | "codex", options: { readonly dryRun?: boolean; readonly force?: boolean } = {}) {
    const migration = await this.migrate(options.dryRun === true);
    const initialized = await this.initializeAdapter(adapter, options);
    return {
      adapter,
      migration,
      configuration: initialized,
      ownership: adapter === "pi" ? "enhance by default; managed-context requires explicit opt-in" : "enhance only",
      nextSteps: adapter === "pi"
        ? ["Install the Pi package with: pi install npm:@agentengram/adapter-pi", "Run: agentengram doctor --adapter pi"]
        : ["Install the packaged Codex plugin using the supported Codex plugin interface", "Run: agentengram doctor --adapter codex"],
    };
  }

  /** Creates or merges a conservative project configuration for one supported adapter. */
  async initializeAdapter(adapter: "pi" | "codex", options: { readonly dryRun?: boolean; readonly force?: boolean } = {}) {
    const loaded = await loadAgentEngramConfig({ cwd: this.cwd, homeDir: this.homeDir });
    const path = loaded.projectConfigPath;
    const existing = await readFile(path, "utf8").then((content) => validateAgentEngramConfig(JSON.parse(content) as unknown))
      .catch((error: unknown) => isMissing(error) ? undefined : Promise.reject(error));
    const initial = initialAgentEngramConfig(adapter);
    const merged = existing ? mergeAgentEngramConfig(initial, existing) : initial;
    const config = this.explicitHomeDir ? { ...merged, dataDir: this.homeDir } : merged;
    if (!options.dryRun) await writeAgentEngramConfig(path, config, options.force === true || existing !== undefined);
    return { adapter, path, dryRun: options.dryRun === true, config };
  }

  /** Returns counts and identities suitable for issue reports. */
  async inspect(): Promise<AgentEngramInspection> {
    const project = await this.project();
    return {
      homeDir: this.homeDir,
      project,
      layout: await inspectDataLayout(this.homeDir),
      memoryRecords: sqliteCount(join(this.homeDir, "indexes", "memory.db"), "SELECT COUNT(*) AS count FROM memories"),
      transcriptSessions: sqliteCount(join(projectStorageRoot(this.homeDir, project.projectId), "transcripts", "index.db"),
        "SELECT COUNT(DISTINCT session_id) AS count FROM transcript_streams"),
      jobs: jobCounts(this.jobsPath(project.projectId)),
    };
  }

  /** Lists durable background jobs without claiming or recovering them. */
  async listJobs(status?: DurableJobStatus): Promise<readonly DurableMemoryJob[]> {
    const project = await this.project();
    const path = this.jobsPath(project.projectId);
    if (!await exists(path)) return [];
    const database = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const rows = (status
        ? database.prepare("SELECT * FROM memory_jobs WHERE status = ? ORDER BY created_at").all(status)
        : database.prepare("SELECT * FROM memory_jobs ORDER BY created_at").all()) as JobRow[];
      return rows.map(decodeJob);
    } finally {
      database.close();
    }
  }

  /** Requeues exactly one dead letter while preserving attempt history. */
  async retryJob(jobId: string): Promise<boolean> {
    if (!jobId.trim()) throw new Error("job id is required");
    await ensureDataLayout(this.homeDir);
    const project = await this.project();
    const path = this.jobsPath(project.projectId);
    if (!await exists(path)) return false;
    const database = new Database(path);
    try {
      const now = new Date().toISOString();
      return database.prepare(`UPDATE memory_jobs SET status = 'pending', next_run_at = ?, lease_owner = NULL,
        lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE job_id = ? AND status = 'dead_letter'`)
        .run(now, now, jobId).changes === 1;
    } finally {
      database.close();
    }
  }

  /** Verifies transcript truth without changing JSONL or its rebuildable projection. */
  async verifyTranscripts(sessionId?: string): Promise<readonly TranscriptVerification[]> {
    await ensureDataLayout(this.homeDir);
    const project = await this.project();
    const store = new TranscriptStore({ rootDir: projectStorageRoot(this.homeDir, project.projectId) });
    try {
      const sessions = sessionId ? [sessionId] : await store.discoverSessions();
      return await Promise.all(sessions.map((id) => store.verify(id)));
    } finally {
      store.close();
    }
  }

  /** Explicitly repairs transcript suffixes, quarantines bytes, and rebuilds offsets. */
  async repairTranscripts(sessionId?: string): Promise<readonly TranscriptVerification[]> {
    await ensureDataLayout(this.homeDir);
    const project = await this.project();
    const store = new TranscriptStore({ rootDir: projectStorageRoot(this.homeDir, project.projectId) });
    try {
      const sessions = sessionId ? [sessionId] : await store.discoverSessions();
      return await Promise.all(sessions.map((id) => store.repair(id)));
    } finally {
      store.close();
    }
  }

  /** Lists exact host mappings without guessing relationships between sessions. */
  listHostBindings(): Promise<readonly HostBinding[]> {
    return new FileHostBindingRepository(join(this.homeDir, "host-bindings")).list();
  }

  /** Rebinds one exact host identity to a caller-selected portable namespace/thread. */
  async rebindHost(input: {
    readonly hostType: string;
    readonly hostProjectId: string;
    readonly hostSessionId: string;
    readonly hostThreadId: string;
    readonly namespaceId: string;
    readonly threadId: string;
  }): Promise<HostBinding> {
    const repository = new FileHostBindingRepository(join(this.homeDir, "host-bindings"));
    const current = await repository.load(input);
    const binding = createHostBinding(current?.identity ?? input, { namespaceId: input.namespaceId, threadId: input.threadId });
    await repository.save(binding);
    return binding;
  }

  exportBundle(options: Omit<ExportPortableBundleOptions, "homeDir" | "projectId"> & { readonly projectId?: string }) {
    return this.project().then((project) => exportPortableBundle({
      ...options,
      homeDir: this.homeDir,
      projectId: options.projectId ?? project.projectId,
    }));
  }

  /** Imports portable truth, then rebuilds FTS and transcript offset projections. */
  async importBundle(options: Omit<ImportPortableBundleOptions, "homeDir">) {
    const result = await importPortableBundle({ ...options, homeDir: this.homeDir });
    await this.rebuildMemoryIndex();
    const store = new TranscriptStore({ rootDir: projectStorageRoot(this.homeDir, result.projectId) });
    try {
      for (const sessionId of await store.discoverSessions()) await store.repair(sessionId);
    } finally {
      store.close();
    }
    return result;
  }

  /**
   * Deletes a complete project namespace or one session only after explicit
   * confirmation. Session deletion also clears source waterlines so a resumed
   * host cannot silently skip transcript evidence that was intentionally purged.
   */
  async purgeData(options: {
    readonly sessionId?: string;
    readonly dryRun?: boolean;
    readonly confirmed?: boolean;
  } = {}): Promise<AgentEngramPurgeResult> {
    if (!options.dryRun && !options.confirmed) throw new Error("data purge requires --yes or --dry-run");
    const project = await this.project();
    const projectRoot = projectStorageRoot(this.homeDir, project.projectId);
    const deletedPaths = options.sessionId
      ? [
          join(projectRoot, "transcripts", storagePathSegment(options.sessionId)),
          join(projectRoot, "threads", storagePathSegment(options.sessionId)),
          join(projectRoot, "session-memory", `${storagePathSegment(options.sessionId)}.json`),
          join(projectRoot, "source-checkpoints"),
          join(this.homeDir, "source-checkpoints", createHash("sha256").update(project.projectId).digest("hex").slice(0, 24)),
        ]
      : [projectRoot];
    const repository = new FileHostBindingRepository(join(this.homeDir, "host-bindings"));
    const bindings = (await repository.list()).filter(({ namespaceId, identity }) =>
      (namespaceId === project.projectId || identity.hostProjectId === project.projectId)
      && (!options.sessionId || identity.hostSessionId === options.sessionId));
    let removedBlobs = 0;
    if (!options.dryRun) {
      if (options.sessionId) {
        const transcripts = new TranscriptStore({ rootDir: projectRoot });
        try {
          removedBlobs = (await transcripts.purgeSession(options.sessionId)).removedBlobs;
        } finally {
          transcripts.close();
        }
      }
      for (const [index, path] of deletedPaths.entries()) {
        if (options.sessionId && index === 0) continue;
        await rm(path, { recursive: true, force: true });
      }
      for (const binding of bindings) await repository.remove(binding.identity);
      await this.rebuildMemoryIndex();
    }
    return {
      projectId: project.projectId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      dryRun: options.dryRun === true,
      deletedPaths,
      removedBindings: bindings.length,
      removedBlobs,
    };
  }

  /** Applies transcript retention using session directory modification time. */
  async pruneTranscripts(options: { readonly days?: number; readonly dryRun?: boolean; readonly confirmed?: boolean }) {
    const configured = options.days ?? (await loadAgentEngramConfig({ cwd: this.cwd, homeDir: this.homeDir })).config.retention?.transcriptDays;
    if (!configured || !Number.isSafeInteger(configured) || configured < 1) {
      throw new Error("transcript retention days must be set with --days or retention.transcriptDays");
    }
    if (!options.dryRun && !options.confirmed) throw new Error("transcript prune requires --yes or --dry-run");
    const project = await this.project();
    const root = join(projectStorageRoot(this.homeDir, project.projectId), "transcripts");
    const cutoff = Date.now() - configured * 86_400_000;
    const sessions: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const metadata = await stat(join(root, entry.name));
      if (metadata.mtimeMs < cutoff) sessions.push(await storedSessionId(join(root, entry.name), entry.name));
    }
    if (!options.dryRun) {
      for (const sessionId of sessions) await this.purgeData({ sessionId, confirmed: true });
    }
    return { projectId: project.projectId, days: configured, dryRun: options.dryRun === true, sessions };
  }

  /** Rebuilds the complete FTS projection exclusively from Markdown truth. */
  async rebuildMemoryIndex(): Promise<number> {
    await ensureDataLayout(this.homeDir);
    await mkdir(join(this.homeDir, "indexes"), { recursive: true, mode: 0o700 });
    const index = new SqliteFtsMemoryIndex(join(this.homeDir, "indexes", "memory.db"));
    const store = new MarkdownMemoryStore(this.homeDir);
    let count = 0;
    try {
      index.clear();
      for (const scope of ["user", "agent"] as const) {
        for (const record of await store.list(scope)) { index.upsert(record); count++; }
      }
      const projects = await directoryNames(join(this.homeDir, "projects"));
      for (const projectId of projects) {
        for (const scope of ["project", "local", "team"] as const) {
          for (const record of await store.list(scope, projectId)) { index.upsert(record); count++; }
        }
      }
      if (index.count() !== count) throw new Error("rebuilt FTS record count does not match Markdown truth");
      return count;
    } finally {
      index.close();
    }
  }

  migrate(dryRun = false): Promise<DataMigrationResult> {
    return migrateDataLayout(this.homeDir, { dryRun });
  }

  private async project(): Promise<ProjectIdentity> {
    const detected = await resolveProjectIdentity(this.cwd);
    return this.explicitProjectId ? { ...detected, projectId: this.explicitProjectId } : detected;
  }

  private jobsPath(projectId: string): string {
    return join(projectRuntimeRoot(this.homeDir, projectId), "memory-jobs.db");
  }
}

interface JobRow {
  readonly job_id: string; readonly kind: string; readonly partition_key: string; readonly payload: string;
  readonly status: DurableJobStatus; readonly attempts: number; readonly next_run_at: string;
  readonly lease_owner: string | null; readonly lease_expires_at: string | null; readonly last_error: string | null;
  readonly created_at: string; readonly updated_at: string;
}

function decodeJob(row: JobRow): DurableMemoryJob {
  return {
    jobId: row.job_id, kind: row.kind, partitionKey: row.partition_key, payload: JSON.parse(row.payload) as unknown,
    status: row.status, attempts: row.attempts, nextRunAt: row.next_run_at,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function jobCounts(path: string): Record<DurableJobStatus, number> {
  const empty = { pending: 0, processing: 0, completed: 0, dead_letter: 0 };
  try {
    const database = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const rows = database.prepare("SELECT status, COUNT(*) AS count FROM memory_jobs GROUP BY status")
        .all() as Array<{ status: DurableJobStatus; count: number }>;
      for (const row of rows) empty[row.status] = row.count;
      return empty;
    } finally { database.close(); }
  } catch { return empty; }
}

function sqliteCount(path: string, query: string): number {
  try {
    const database = new Database(path, { readonly: true, fileMustExist: true });
    try { return (database.prepare(query).get() as { count: number }).count; }
    finally { database.close(); }
  } catch { return 0; }
}

function sqliteCheck(): DoctorCheck {
  try {
    const database = new Database(":memory:");
    try {
      database.exec("CREATE VIRTUAL TABLE agentengram_fts_probe USING fts5(content)");
    } finally {
      database.close();
    }
    return { name: "sqlite-fts5", status: "ok", message: "better-sqlite3 native binding and FTS5 are available" };
  } catch (error) {
    return {
      name: "sqlite-fts5",
      status: "error",
      message: `SQLite initialization failed; allow the better-sqlite3 install script: ${errorMessage(error)}`,
    };
  }
}

function adapterConfigurationCheck(adapter: "pi" | "codex", config: AgentEngramConfig): DoctorCheck {
  if (adapter === "pi") {
    const mode = config.adapters?.pi?.mode ?? config.context?.defaultMode;
    if (!mode) return { name: "adapter-pi", status: "warning", message: "Pi is not configured; run agentengram init pi" };
    const compact = config.adapters?.pi?.models?.compact?.strategy ?? config.models?.compact?.strategy;
    if (mode === "managed-context" && (compact === undefined || compact === "disabled")) {
      return { name: "adapter-pi", status: "error", message: "Pi managed-context requires an enabled compact model strategy" };
    }
    return { name: "adapter-pi", status: "ok", message: `configured mode=${mode}, compact=${compact ?? "adapter-default"}` };
  }
  const mode = config.adapters?.codex?.mode ?? config.context?.defaultMode;
  if (mode === "managed-context") {
    return { name: "adapter-codex", status: "error", message: "Codex does not support managed-context" };
  }
  if (!config.adapters?.codex) return { name: "adapter-codex", status: "warning", message: "Codex is not configured; run agentengram init codex" };
  return {
    name: "adapter-codex",
    status: "ok",
    message: `configured mode=${config.adapters.codex.mode ?? "enhance"}, formation=${config.adapters.codex.models?.formation?.strategy ?? config.models?.formation?.strategy ?? "adapter-default"}`,
  };
}

/** Checks host presence without treating an optional local CLI as a data error. */
function hostExecutableCheck(adapter: "pi" | "codex"): DoctorCheck {
  const executable = adapter === "pi" ? "pi" : "codex";
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5_000 });
  const version = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0];
  return result.status === 0
    ? { name: `${adapter}-host`, status: "ok", message: version || `${executable} is available` }
    : { name: `${adapter}-host`, status: "warning", message: `${executable} was not found on PATH; runtime configuration can still be validated` };
}

/** Validates model readiness only when the selected adapter requests a configured provider. */
function providerConfigurationCheck(adapter: "pi" | "codex", config: AgentEngramConfig): DoctorCheck {
  const tasks = config.adapters?.[adapter]?.models;
  const selected = [tasks?.compact, tasks?.formation, config.models?.compact, config.models?.formation]
    .some((task) => task?.strategy === "configured-provider" || task?.fallback === "configured-provider");
  if (!selected) return { name: "provider", status: "ok", message: "no configured provider is required by the selected adapter policy" };
  const provider = config.provider;
  if (!provider?.model || !provider.apiKeyEnv) {
    return { name: "provider", status: "error", message: "configured-provider requires provider.model and provider.apiKeyEnv" };
  }
  return process.env[provider.apiKeyEnv]
    ? { name: "provider", status: "ok", message: `${provider.type ?? "openai-compatible"} model=${provider.model}; credential environment is present` }
    : { name: "provider", status: "error", message: `credential environment ${provider.apiKeyEnv} is not set` };
}

async function pathCheck(name: string, path: string): Promise<DoctorCheck> {
  try {
    await access(path);
    return { name, status: "ok", message: path };
  } catch {
    return { name, status: "warning", message: `${path} does not exist yet` };
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

async function directoryNames(path: string): Promise<readonly string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function storedSessionId(directory: string, fallback: string): Promise<string> {
  for (const [name, decode] of [
    ["raw.jsonl", decodeRawTranscriptRecord],
    ["normalized.jsonl", decodeNormalizedTranscriptEntry],
  ] as const) {
    const content = await readFile(join(directory, name), "utf8").catch((error: unknown) => isMissing(error) ? "" : Promise.reject(error));
    const first = content.split("\n").find((line) => line.trim());
    if (!first) continue;
    try {
      const value = decode(first);
      return "frameworkSessionId" in value ? value.frameworkSessionId : value.sessionId;
    } catch {
      // Retention still removes the storage directory by its stable segment if
      // the first record is malformed; explicit repair can preserve suffixes.
    }
  }
  return fallback;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
