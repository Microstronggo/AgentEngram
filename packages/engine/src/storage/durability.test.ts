import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncDirectory } from "./durability.js";

describe("directory durability", () => {
  it("skips unsupported directory fsync on Windows", async () => {
    await expect(syncDirectory("path-that-must-not-be-opened", "win32")).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("syncs a directory on POSIX platforms", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentengram-directory-sync-"));
    try {
      await expect(syncDirectory(directory)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
