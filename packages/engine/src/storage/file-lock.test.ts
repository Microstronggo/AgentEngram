import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireFileLock } from "./file-lock.js";

describe("acquireFileLock", () => {
  it("waits for a live owner and proceeds after token-aware release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentengram-lock-"));
    const path = join(directory, "append.lock");
    const first = await acquireFileLock(path);
    const secondPromise = acquireFileLock(path, { timeoutMs: 1_000, retryDelayMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await first.release();
    const second = await secondPromise;
    await second.release();
  });

  it("recovers a malformed stale lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentengram-lock-"));
    const path = join(directory, "append.lock");
    await writeFile(path, "broken", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const lease = await acquireFileLock(path, { malformedStaleAfterMs: 1, timeoutMs: 100 });
    await lease.release();
  });
});
