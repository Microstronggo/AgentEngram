import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

export interface CodexWorkerLease {
  /** Stops the heartbeat and releases this process's project worker lease. */
  release(): Promise<void>;
}

/**
 * Acquires one heartbeat-backed worker lease per project. Durable job leases
 * prevent duplicate completion; this coarser lease also avoids spawning many
 * idle sidecars when several command hooks fire at once.
 */
export async function acquireCodexWorkerLease(
  homeDir: string,
  projectId: string,
  options: { readonly staleAfterMs?: number; readonly heartbeatMs?: number } = {},
): Promise<CodexWorkerLease | undefined> {
  const directory = join(homeDir, "locks", "codex-workers");
  const path = join(directory, `${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}.lock`);
  const staleAfterMs = Math.max(1_000, options.staleAfterMs ?? 30_000);
  const heartbeatMs = Math.max(250, options.heartbeatMs ?? Math.floor(staleAfterMs / 3));
  await mkdir(directory, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, projectId, createdAt: new Date().toISOString() }), "utf8");
      await file.sync();
      await file.close();
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(path, now, now).catch(() => undefined);
      }, heartbeatMs);
      heartbeat.unref?.();
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          // Only unlink a lease still owned by this process. A stale recovery
          // may have replaced the file while a suspended process was waking.
          const owner = await readOwnerPid(path);
          if (owner === process.pid) await rm(path, { force: true });
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const metadata = await stat(path).catch(() => undefined);
      const owner = await readOwnerPid(path);
      const live = owner !== undefined && isProcessAlive(owner);
      if (live || (metadata && Date.now() - metadata.mtimeMs <= staleAfterMs)) return undefined;
      await rm(path, { force: true });
    }
  }
  return undefined;
}

async function readOwnerPid(path: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) ? parsed.pid : undefined;
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
