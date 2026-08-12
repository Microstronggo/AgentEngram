import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHostBinding } from "../protocol/host-identity.js";
import { ensureDataLayout } from "./data-layout.js";
import { FileHostBindingRepository } from "./host-binding-repository.js";
import { exportPortableBundle, importPortableBundle } from "./portable-bundle.js";
import { projectStorageRoot } from "./storage-paths.js";
import { mkdir } from "node:fs/promises";
import { createMemoryRecord } from "../memory/long-term/records/memory-record.js";
import { serializeMemoryMarkdown } from "../memory/long-term/records/markdown-codec.js";

describe("portable AgentEngram bundles", () => {
  it("exports checksummed truth, excludes projections, and imports bindings only on opt-in", async () => {
    const source = await temporaryDirectory("source");
    const target = await temporaryDirectory("target");
    const bundle = join(await temporaryDirectory("container"), "bundle");
    const projectId = "portable-project";
    await ensureDataLayout(source);
    const project = projectStorageRoot(source, projectId);
    await mkdir(join(project, "transcripts", "s1"), { recursive: true });
    await writeFile(join(project, "transcripts", "s1", "raw.jsonl"), `${JSON.stringify({
      schemaVersion: 1,
      id: "raw",
      framework: "test",
      frameworkSessionId: "s1",
      frameworkThreadId: "t1",
      eventType: "message.created",
      role: "user",
      timestamp: "2026-01-01T00:00:00.000Z",
      contentHash: "hash",
      sourceRef: "agentengram://transcript/s1/t1/raw",
    })}\n`, "utf8");
    await writeFile(join(project, "transcripts", "index.db"), "rebuildable", "utf8");
    await mkdir(join(project, "project"), { recursive: true });
    const markdown = memoryMarkdown("durable truth", projectId);
    await writeFile(join(project, "project", "memory.md"), markdown, "utf8");
    const bindings = new FileHostBindingRepository(join(source, "host-bindings"));
    await bindings.save(createHostBinding({
      hostType: "pi", hostProjectId: projectId, hostSessionId: "s1", hostThreadId: "t1",
    }, { namespaceId: projectId }));

    const manifest = await exportPortableBundle({
      homeDir: source, projectId, outputDir: bundle, includeHostBindings: true,
    });
    expect(manifest.files.map(({ path }) => path)).toContain(`data/projects/${projectId}/project/memory.md`);
    expect(manifest.files.some(({ path }) => path.endsWith("index.db"))).toBe(false);
    expect(manifest.files.some(({ kind }) => kind === "binding")).toBe(true);

    const first = await importPortableBundle({ homeDir: target, inputDir: bundle });
    expect(first).toMatchObject({ projectId, importedBindings: 0, importedFiles: 2 });
    expect(await new FileHostBindingRepository(join(target, "host-bindings")).list()).toEqual([]);
    expect(await readFile(join(projectStorageRoot(target, projectId), "project", "memory.md"), "utf8"))
      .toBe(markdown);

    const second = await importPortableBundle({ homeDir: target, inputDir: bundle, includeHostBindings: true });
    expect(second).toMatchObject({ importedFiles: 0, skippedFiles: 2, importedBindings: 1 });
  });

  it("verifies all checksums before writing target truth", async () => {
    const source = await temporaryDirectory("source");
    const target = await temporaryDirectory("target");
    const bundle = join(await temporaryDirectory("container"), "bundle");
    const projectId = "p";
    await ensureDataLayout(source);
    const project = projectStorageRoot(source, projectId);
    await mkdir(join(project, "project"), { recursive: true });
    await writeFile(join(project, "project", "memory.md"), memoryMarkdown("original", projectId), "utf8");
    const manifest = await exportPortableBundle({ homeDir: source, projectId, outputDir: bundle });
    await writeFile(join(bundle, manifest.files[0]!.path), "tampered", "utf8");

    await expect(importPortableBundle({ homeDir: target, inputDir: bundle })).rejects.toThrow("checksum mismatch");
    await expect(readFile(projectStorageRoot(target, projectId))).rejects.toThrow();
  });

  it("preflights every target conflict before copying the first file", async () => {
    const source = await temporaryDirectory("source");
    const target = await temporaryDirectory("target");
    const bundle = join(await temporaryDirectory("container"), "bundle");
    const projectId = "p";
    await ensureDataLayout(source);
    const sourceProject = projectStorageRoot(source, projectId);
    await mkdir(join(sourceProject, "project"), { recursive: true });
    await writeFile(join(sourceProject, "project", "a.md"), memoryMarkdown("source-a", projectId, "a"), "utf8");
    await writeFile(join(sourceProject, "project", "z.md"), memoryMarkdown("source-z", projectId, "z"), "utf8");
    await exportPortableBundle({ homeDir: source, projectId, outputDir: bundle });
    const targetProject = projectStorageRoot(target, projectId);
    await mkdir(join(targetProject, "project"), { recursive: true });
    await writeFile(join(targetProject, "project", "z.md"), memoryMarkdown("different-z", projectId, "z"), "utf8");

    await expect(importPortableBundle({ homeDir: target, inputDir: bundle })).rejects.toThrow("would overwrite different truth");
    await expect(readFile(join(targetProject, "project", "a.md"))).rejects.toThrow();
  });

  it("rejects checksum-valid malformed transcript truth before initializing the target", async () => {
    const source = await temporaryDirectory("source");
    const target = await temporaryDirectory("target");
    const bundle = join(await temporaryDirectory("container"), "bundle");
    const projectId = "p";
    const transcript = join(projectStorageRoot(source, projectId), "transcripts", "s1");
    await ensureDataLayout(source);
    await mkdir(transcript, { recursive: true });
    await writeFile(join(transcript, "raw.jsonl"), "{\"malformed\":true}\n", "utf8");
    await exportPortableBundle({ homeDir: source, projectId, outputDir: bundle });

    await expect(importPortableBundle({ homeDir: target, inputDir: bundle })).rejects.toThrow();
    await expect(readFile(join(target, "agentengram.manifest.json"))).rejects.toThrow();
  });

  it("rejects a bundle file replaced by a symbolic link", async () => {
    const source = await temporaryDirectory("source");
    const target = await temporaryDirectory("target");
    const container = await temporaryDirectory("container");
    const bundle = join(container, "bundle");
    const projectId = "p";
    const project = projectStorageRoot(source, projectId);
    await ensureDataLayout(source);
    await mkdir(join(project, "project"), { recursive: true });
    await writeFile(join(project, "project", "memory.md"), memoryMarkdown("linked", projectId), "utf8");
    const manifest = await exportPortableBundle({ homeDir: source, projectId, outputDir: bundle });
    const bundled = join(bundle, manifest.files[0]!.path);
    const external = join(container, "external.md");
    await writeFile(external, await readFile(bundled));
    await rm(bundled);
    try {
      await symlink(external, bundled);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) return;
      throw error;
    }

    await expect(importPortableBundle({ homeDir: target, inputDir: bundle })).rejects.toThrow("symbolic link");
  });
});

async function temporaryDirectory(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `agentengram-bundle-${label}-`));
}

function memoryMarkdown(content: string, projectId: string, id = "memory"): string {
  return serializeMemoryMarkdown(createMemoryRecord({
    id,
    name: id,
    description: "portable bundle fixture",
    content,
    type: "project",
    scope: "project",
    projectId,
    partition: { schemaVersion: 1, projectId },
  }));
}
