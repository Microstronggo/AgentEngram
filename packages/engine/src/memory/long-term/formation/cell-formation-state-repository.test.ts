import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileCellFormationStateRepository } from "./cell-formation-state-repository.js";

describe("FileCellFormationStateRepository", () => {
  it("round-trips isolated per-thread cursor, tail, and pending Cells", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-cell-state-"));
    const repository = new FileCellFormationStateRepository(root);
    await repository.save({ sessionId: "s1", threadId: "t1" }, {
      schemaVersion: 1,
      transcriptCursor: "entry-2",
      tail: [{ id: "entry-2", role: "user", text: "continue", sourceRef: "source:2" }],
      pendingCells: [{
        stage: "episode",
        attempts: 0,
        cell: { id: "cell-1", cellType: "episode", trigger: "session", text: "closed", sourceEntryIds: ["source:1"] },
      }],
      deadLetters: [],
      updatedAt: "2026-06-27T00:00:00.000Z",
    });

    await expect(repository.load({ sessionId: "s1", threadId: "t1" })).resolves.toMatchObject({
      transcriptCursor: "entry-2",
      tail: [{ id: "entry-2" }],
      pendingCells: [{ stage: "episode", cell: { id: "cell-1" } }],
    });
    await expect(repository.load({ sessionId: "s1", threadId: "t2" })).resolves.toMatchObject({
      tail: [],
      pendingCells: [],
    });
  });

  it("upgrades additive schema-version-one state without reliability fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-cell-state-legacy-"));
    const path = join(root, "threads", "s1", "t1", "formation-state.json");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "threads", "s1", "t1"), { recursive: true }));
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      tail: [],
      pendingCells: [],
      updatedAt: "2026-06-27T00:00:00.000Z",
    }), "utf8");

    await expect(new FileCellFormationStateRepository(root).load({ sessionId: "s1", threadId: "t1" }))
      .resolves.toMatchObject({ deadLetters: [] });
  });

  it("rejects a corrupt durable state instead of resetting the cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-cell-state-corrupt-"));
    const path = join(root, "threads", "s1", "t1", "formation-state.json");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "threads", "s1", "t1"), { recursive: true }));
    await writeFile(path, "{\"schemaVersion\":1,\"tail\":\"bad\"}\n", "utf8");
    await expect(new FileCellFormationStateRepository(root).load({ sessionId: "s1", threadId: "t1" }))
      .rejects.toThrow("invalid Cell formation state");
  });
});
