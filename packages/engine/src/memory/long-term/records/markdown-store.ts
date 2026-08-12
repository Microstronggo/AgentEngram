import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseMemoryMarkdown, serializeMemoryMarkdown } from "./markdown-codec.js";
import type { MemoryRecord } from "./memory-record.js";
import { LEGACY_PARTITION_IDS, memoryPartitionKey, type MemoryPartition } from "./memory-partition.js";
import { MarkdownMemoryIndex } from "./memory-index.js";

/** Filesystem source of truth for scoped Markdown memory records. */
export class MarkdownMemoryStore {
  /** @param rootDir AgentEngram data root containing project and global scopes. */
  public constructor(private readonly rootDir: string) {}

  public async put(record: MemoryRecord): Promise<void> {
    validateLocation(record, record.scope, record.projectId);
    const directory = this.scopeDirectory(record);
    await mkdir(directory, { recursive: true });
    const target = join(directory, storageFileName(record.id, record.scope, record.partition));
    // Record and index writes use atomic replacement so readers never observe partial Markdown.
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeAtomic(temporary, target, serializeMemoryMarkdown(record));
    await this.rebuildIndex(record.scope, record.projectId);
  }

  public async get(scope: MemoryRecord["scope"], id: string, projectId?: string, partition?: MemoryPartition): Promise<MemoryRecord | null> {
    try {
      const directory = this.directoryFor(scope, projectId);
      const exact = join(directory, storageFileName(id, scope, partition));
      let markdown = await readFile(exact, "utf8").catch((error: unknown) => isMissing(error) ? undefined : Promise.reject(error));
      if (markdown === undefined && partition === undefined) {
        const names = (await readdir(directory)).filter((name) => name.startsWith(`${safeComponent(id)}--`) && name.endsWith(".md"));
        if (names.length > 1) throw new Error("memory id is ambiguous across partitions");
        if (names[0]) markdown = await readFile(join(directory, names[0]), "utf8");
      }
      if (markdown === undefined) return null;
      const record = parseMemoryMarkdown(markdown);
      validateLocation(record, scope, projectId);
      if (partition && memoryPartitionKey(record.partition) !== memoryPartitionKey(partition)) return null;
      return record;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  public async list(scope: MemoryRecord["scope"], projectId?: string): Promise<MemoryRecord[]> {
    const directory = this.directoryFor(scope, projectId);
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const records = await Promise.all(
      files
        .filter((file) => file.endsWith(".md") && file !== "MEMORY.md")
        .map(async (file) => {
          const record = parseMemoryMarkdown(await readFile(join(directory, file), "utf8"));
          validateLocation(record, scope, projectId);
          return record;
        }),
    );
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async remove(scope: MemoryRecord["scope"], id: string, projectId?: string, partition?: MemoryPartition): Promise<void> {
    const record = await this.get(scope, id, projectId, partition);
    if (!record) return;
    await rm(join(this.directoryFor(scope, projectId), storageFileName(id, scope, record.partition)), { force: true });
    await this.rebuildIndex(scope, projectId);
  }

  public async readIndex(scope: MemoryRecord["scope"], projectId?: string): Promise<string> {
    return new MarkdownMemoryIndex(this.directoryFor(scope, projectId)).read();
  }

  /** Cross-process partition lock protecting read-check-write revision semantics. */
  public async withWriteLock<T>(
    scope: MemoryRecord["scope"],
    projectId: string | undefined,
    partition: MemoryPartition,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lockDirectory = join(this.rootDir, "locks");
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    const lockPath = join(lockDirectory, `${scope}-${safeComponent(projectId ?? "global")}-${memoryPartitionKey(partition).slice(0, 24)}.lock`);
    const deadline = Date.now() + 5_000;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    while (!lock) {
      try {
        lock = await open(lockPath, "wx", 0o600);
        await lock.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const metadata = await stat(lockPath).catch(() => undefined);
        if (metadata && Date.now() - metadata.mtimeMs > 30_000) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new Error("timed out acquiring memory partition write lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await operation();
    } finally {
      await lock.close().catch(() => undefined);
      await rm(lockPath, { force: true });
    }
  }

  private async rebuildIndex(scope: MemoryRecord["scope"], projectId?: string): Promise<void> {
    await new MarkdownMemoryIndex(this.directoryFor(scope, projectId)).rebuild(await this.list(scope, projectId));
  }

  private scopeDirectory(record: MemoryRecord): string {
    return this.directoryFor(record.scope, record.projectId);
  }

  private directoryFor(scope: MemoryRecord["scope"], projectId?: string): string {
    if (scope === "project" || scope === "local" || scope === "team") {
      if (!projectId) throw new Error(`${scope} memory requires projectId`);
      return join(this.rootDir, "projects", safeComponent(projectId), scope);
    }
    return join(this.rootDir, "global", scope);
  }
}

function storageFileName(id: string, scope: MemoryRecord["scope"], partition?: MemoryPartition): string {
  const base = safeComponent(id);
  if (!partition || isLegacyLocation(scope, partition)) return `${base}.md`;
  return `${base}--${memoryPartitionKey(partition).slice(0, 16)}.md`;
}

function isLegacyLocation(scope: MemoryRecord["scope"], partition: MemoryPartition): boolean {
  const only = (...allowed: readonly string[]) => Object.entries(partition)
    .every(([key, value]) => key === "schemaVersion" || value === undefined || allowed.includes(key));
  if (scope === "project") return Boolean(partition.projectId) && only("projectId");
  if (scope === "local") return partition.worktreeId === LEGACY_PARTITION_IDS.worktreeId && only("projectId", "worktreeId");
  if (scope === "user") return partition.userId === LEGACY_PARTITION_IDS.userId && only("userId");
  if (scope === "agent") return partition.agentId === LEGACY_PARTITION_IDS.agentId && only("agentId");
  return partition.teamId === LEGACY_PARTITION_IDS.teamId && only("projectId", "teamId");
}

function validateLocation(
  record: Pick<MemoryRecord, "scope" | "projectId">,
  expectedScope: MemoryRecord["scope"],
  expectedProjectId?: string,
): void {
  if (record.scope !== expectedScope) throw new Error("memory scope does not match its storage location");
  const projectScoped = ["project", "local", "team"].includes(expectedScope);
  if (projectScoped && record.projectId !== expectedProjectId) {
    throw new Error("memory projectId does not match its storage location");
  }
  if (!projectScoped && record.projectId !== undefined) {
    throw new Error(`${expectedScope} memory must not declare projectId`);
  }
}

async function writeAtomic(temporary: string, target: string, content: string): Promise<void> {
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await file.close();
  await rename(temporary, target);
  const directory = await open(dirname(target), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function safeComponent(value: string): string {
  if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error("unsafe memory path component");
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
