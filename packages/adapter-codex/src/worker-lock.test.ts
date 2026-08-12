import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireCodexWorkerLease } from "./worker-lock.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Codex worker lease", () => {
  it("allows one effective project worker and releases ownership idempotently", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agentengram-codex-worker-lock-"));
    directories.push(homeDir);
    const first = await acquireCodexWorkerLease(homeDir, "project-a", { staleAfterMs: 2_000 });
    expect(first).toBeDefined();
    await expect(acquireCodexWorkerLease(homeDir, "project-a", { staleAfterMs: 2_000 }))
      .resolves.toBeUndefined();

    await first?.release();
    await first?.release();
    const replacement = await acquireCodexWorkerLease(homeDir, "project-a", { staleAfterMs: 2_000 });
    expect(replacement).toBeDefined();
    await replacement?.release();
  });
});
