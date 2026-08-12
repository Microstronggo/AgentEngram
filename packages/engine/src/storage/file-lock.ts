import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Ownership token written into one local cross-process lock file. */
interface FileLockOwner {
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
}

/** Options for bounded acquisition of a short local filesystem critical section. */
export interface FileLockOptions {
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly malformedStaleAfterMs?: number;
}

/** Handle whose token-aware release cannot delete a replacement owner's lock. */
export interface FileLockLease {
  readonly path: string;
  release(): Promise<void>;
}

/**
 * Acquires a local cross-process lock using exclusive file creation. Live PID
 * ownership prevents age-based stealing while malformed/dead locks recover
 * automatically, which keeps transcript append critical sections bounded.
 */
export async function acquireFileLock(path: string, options: FileLockOptions = {}): Promise<FileLockLease> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? 10);
  const malformedStaleAfterMs = Math.max(1, options.malformedStaleAfterMs ?? 30_000);
  const deadline = Date.now() + timeoutMs;
  const owner: FileLockOwner = { pid: process.pid, token: randomUUID(), acquiredAt: new Date().toISOString() };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      let released = false;
      return {
        path,
        release: async () => {
          if (released) return;
          released = true;
          const current = await readOwner(path);
          if (current?.token === owner.token) await rm(path, { force: true });
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await isRecoverableLock(path, malformedStaleAfterMs)) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out acquiring file lock: ${path}`);
      await delay(retryDelayMs);
    }
  }
}

async function isRecoverableLock(path: string, malformedStaleAfterMs: number): Promise<boolean> {
  const owner = await readOwner(path);
  if (owner) return !isProcessAlive(owner.pid);
  const metadata = await stat(path).catch(() => undefined);
  return metadata === undefined || Date.now() - metadata.mtimeMs > malformedStaleAfterMs;
}

async function readOwner(path: string): Promise<FileLockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<FileLockOwner>;
    if (!Number.isSafeInteger(value.pid) || typeof value.token !== "string" || typeof value.acquiredAt !== "string") {
      return undefined;
    }
    return value as FileLockOwner;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
