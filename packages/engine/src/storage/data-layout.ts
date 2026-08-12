import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireFileLock } from "./file-lock.js";

/** Current durable root layout understood by this Engine release. */
export const AGENTENGRAM_DATA_LAYOUT_VERSION = 1 as const;

/** Component versions let future migrations evolve one truth format at a time. */
export interface AgentEngramDataManifest {
  readonly product: "agentengram";
  readonly schemaVersion: typeof AGENTENGRAM_DATA_LAYOUT_VERSION;
  readonly components: {
    readonly markdownMemory: 1;
    readonly portableTranscript: 1;
    readonly projectionLog: 1;
    readonly checkpoint: 1;
    readonly hostBinding: 1;
    readonly cellFormation: 1;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Read-only classification used by doctor before it makes any migration decision. */
export type DataLayoutInspection =
  | { readonly status: "uninitialized" | "legacy"; readonly version: 0; readonly discoveredEntries: readonly string[] }
  | { readonly status: "current"; readonly version: 1; readonly manifest: AgentEngramDataManifest }
  | { readonly status: "unsupported"; readonly version: number; readonly reason: string };

/** Result of a version transition or an idempotent current-layout check. */
export interface DataMigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changed: boolean;
  readonly dryRun: boolean;
  readonly journalPath?: string;
}

/** Inspects the durable root without creating files or modifying legacy data. */
export async function inspectDataLayout(rootDir: string): Promise<DataLayoutInspection> {
  const path = manifestPath(rootDir);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    const entries = await readdir(rootDir).catch((readError: unknown) => {
      if (isMissing(readError)) return [];
      throw readError;
    });
    const discoveredEntries = entries.filter((entry) => !entry.startsWith(".")).sort();
    return { status: discoveredEntries.length === 0 ? "uninitialized" : "legacy", version: 0, discoveredEntries };
  }

  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`AgentEngram data manifest is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || typeof value.schemaVersion !== "number" || !Number.isInteger(value.schemaVersion)) {
    throw new Error("AgentEngram data manifest schemaVersion is invalid");
  }
  if (value.schemaVersion !== AGENTENGRAM_DATA_LAYOUT_VERSION) {
    return {
      status: "unsupported",
      version: value.schemaVersion,
      reason: value.schemaVersion > AGENTENGRAM_DATA_LAYOUT_VERSION
        ? "data was written by a newer AgentEngram release"
        : "no registered migration path is available",
    };
  }
  const manifest = validateManifest(value);
  return { status: "current", version: 1, manifest };
}

/** Ensures the current layout, adopting existing pre-manifest V1 files safely. */
export async function ensureDataLayout(rootDir: string): Promise<AgentEngramDataManifest> {
  const inspection = await inspectDataLayout(rootDir);
  if (inspection.status === "current") return inspection.manifest;
  if (inspection.status === "unsupported") throw new Error(`unsupported AgentEngram data layout ${inspection.version}: ${inspection.reason}`);
  await migrateDataLayout(rootDir);
  const migrated = await inspectDataLayout(rootDir);
  if (migrated.status !== "current") throw new Error("AgentEngram data layout migration did not publish a manifest");
  return migrated.manifest;
}

/**
 * Runs the registered 0 -> 1 adoption under a root lock. The transition writes
 * a durable journal before publishing the manifest and never rewrites existing
 * Markdown, JSONL, checkpoint, or SQLite files.
 */
export async function migrateDataLayout(
  rootDir: string,
  options: { readonly dryRun?: boolean } = {},
): Promise<DataMigrationResult> {
  const before = await inspectDataLayout(rootDir);
  if (before.status === "current") return { fromVersion: 1, toVersion: 1, changed: false, dryRun: options.dryRun === true };
  if (before.status === "unsupported") throw new Error(`unsupported AgentEngram data layout ${before.version}: ${before.reason}`);
  if (options.dryRun) return { fromVersion: 0, toVersion: 1, changed: true, dryRun: true };

  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  const lease = await acquireFileLock(join(rootDir, ".data-layout.lock"));
  try {
    const current = await inspectDataLayout(rootDir);
    if (current.status === "current") return { fromVersion: 1, toVersion: 1, changed: false, dryRun: false };
    if (current.status === "unsupported") throw new Error(`unsupported AgentEngram data layout ${current.version}: ${current.reason}`);
    const migrationId = `0-to-1-${Date.now()}-${randomUUID()}`;
    const journalPath = join(rootDir, ".migrations", `${migrationId}.json`);
    const now = new Date().toISOString();
    const journal = {
      migrationId,
      fromVersion: 0,
      toVersion: 1,
      status: "started",
      startedAt: now,
      discoveredEntries: current.discoveredEntries,
      note: "Adopts existing V1 files without rewriting durable truth.",
    };
    await writeJsonAtomic(journalPath, journal);
    const manifest = createManifest(now);
    await writeJsonAtomic(manifestPath(rootDir), manifest);
    await writeJsonAtomic(journalPath, { ...journal, status: "completed", completedAt: new Date().toISOString() });
    return { fromVersion: 0, toVersion: 1, changed: true, dryRun: false, journalPath };
  } finally {
    await lease.release();
  }
}

function createManifest(now: string): AgentEngramDataManifest {
  return {
    product: "agentengram",
    schemaVersion: 1,
    components: {
      markdownMemory: 1,
      portableTranscript: 1,
      projectionLog: 1,
      checkpoint: 1,
      hostBinding: 1,
      cellFormation: 1,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function validateManifest(value: Record<string, unknown>): AgentEngramDataManifest {
  if (value.product !== "agentengram" || value.schemaVersion !== 1 || !isRecord(value.components)) {
    throw new Error("AgentEngram data manifest identity is invalid");
  }
  for (const component of ["markdownMemory", "portableTranscript", "projectionLog", "checkpoint", "hostBinding", "cellFormation"]) {
    if (value.components[component] !== 1) throw new Error(`AgentEngram data manifest component is invalid: ${component}`);
  }
  if (!validDate(value.createdAt) || !validDate(value.updatedAt)) throw new Error("AgentEngram data manifest timestamps are invalid");
  return value as unknown as AgentEngramDataManifest;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function manifestPath(rootDir: string): string {
  return join(rootDir, "agentengram.manifest.json");
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
