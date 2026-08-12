import { createHash } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface CodexSessionLockOptions {
  readonly waitTimeoutMs?: number;
  readonly staleAfterMs?: number;
  readonly retryDelayMs?: number;
}

/**
 * Serializes command-hook processes for one Codex session.
 * Codex hooks are normally ordered, but subagents can finish concurrently and
 * otherwise race TranscriptStore's atomic rewrite snapshots.
 */
export async function acquireCodexSessionLock(
  homeDir: string,
  sessionId: string,
  options: CodexSessionLockOptions = {},
): Promise<() => Promise<void>> {
  const directory = join(homeDir, "locks", "codex");
  const path = join(directory, `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.lock`);
  const waitTimeoutMs = Math.max(1, options.waitTimeoutMs ?? 20_000);
  const staleAfterMs = Math.max(1, options.staleAfterMs ?? 120_000);
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? 50);
  const deadline = Date.now() + waitTimeoutMs;
  await mkdir(directory, { recursive: true, mode: 0o700 });

  while (true) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
      await file.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(path, { force: true });
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const metadata = await stat(path).catch(() => undefined);
      if (metadata && Date.now() - metadata.mtimeMs > staleAfterMs) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for Codex session lock: ${sessionId}`);
      await delay(retryDelayMs);
    }
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
