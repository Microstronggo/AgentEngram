import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireCodexSessionLock } from "./session-lock.js";

describe("Codex session lock", () => {
  it("serializes concurrent hook processes for one session", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentengram-codex-lock-"));
    const releaseFirst = await acquireCodexSessionLock(home, "session-1");
    let acquiredSecond = false;
    const second = acquireCodexSessionLock(home, "session-1", { retryDelayMs: 5 })
      .then((release) => { acquiredSecond = true; return release; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acquiredSecond).toBe(false);
    await releaseFirst();
    const releaseSecond = await second;
    expect(acquiredSecond).toBe(true);
    await releaseSecond();
    await rm(home, { recursive: true, force: true });
  });
});
