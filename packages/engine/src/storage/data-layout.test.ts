import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDataLayout, inspectDataLayout, migrateDataLayout } from "./data-layout.js";

describe("AgentEngram data layout", () => {
  it("creates a versioned manifest and durable migration journal for a fresh root", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-layout-"));
    const result = await migrateDataLayout(root);
    const inspection = await inspectDataLayout(root);

    expect(result).toMatchObject({ fromVersion: 0, toVersion: 1, changed: true, dryRun: false });
    expect(inspection).toMatchObject({ status: "current", version: 1 });
    await expect(access(result.journalPath!)).resolves.toBeUndefined();
  });

  it("adopts legacy files without rewriting their contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-layout-"));
    const legacy = join(root, "MEMORY.md");
    await writeFile(legacy, "legacy truth\n", "utf8");
    expect(await inspectDataLayout(root)).toMatchObject({ status: "legacy", discoveredEntries: ["MEMORY.md"] });

    await ensureDataLayout(root);

    expect(await readFile(legacy, "utf8")).toBe("legacy truth\n");
    expect(await inspectDataLayout(root)).toMatchObject({ status: "current", version: 1 });
  });

  it("supports a no-write dry run and rejects newer layouts", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-layout-"));
    await expect(migrateDataLayout(root, { dryRun: true })).resolves.toMatchObject({ changed: true, dryRun: true });
    await expect(access(join(root, "agentengram.manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(root, "agentengram.manifest.json"), JSON.stringify({ product: "agentengram", schemaVersion: 2 }), "utf8");
    await expect(ensureDataLayout(root)).rejects.toThrow("newer AgentEngram release");
  });
});
