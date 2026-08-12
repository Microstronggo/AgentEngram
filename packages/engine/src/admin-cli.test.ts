import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryRecord, MarkdownMemoryStore, SqliteFtsMemoryIndex } from "./memory/index.js";
import { runAdminCli } from "./admin-cli.js";
import { DurableJobRuntime } from "./runtime/durable-job-runtime.js";
import { projectRuntimeRoot, projectStorageRoot } from "./storage/index.js";
import { TranscriptStore } from "./transcript/index.js";

describe("agentengram admin CLI", () => {
  it("prints the package version and effective credential-free configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-cli-version-"));
    const output: string[] = [];
    const io = { stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line) };
    expect(await runAdminCli(["--version"], io)).toBe(0);
    expect(output.pop()).toBe("0.1.0");
    expect(await runAdminCli(["config", "print", "--effective", "--redacted", "--home", root, "--cwd", root], io)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ config: { schemaVersion: 1 } });
  });

  it("migrates, diagnoses, and inspects a fresh installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-cli-"));
    const output: string[] = [];
    const io = { stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line) };
    expect(await runAdminCli(["migrate", "--home", root, "--cwd", root], io)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ fromVersion: 0, toVersion: 1, changed: true });
    expect(await runAdminCli(["doctor", "--home", root, "--cwd", root], io)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ ok: true });
    expect(await runAdminCli(["inspect", "--home", root, "--cwd", root, "--project-id", "p"], io)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ project: { projectId: "p" }, memoryRecords: 0 });
  });

  it("initializes conservative adapter config and diagnoses the selected adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-cli-init-"));
    const project = await mkdtemp(join(tmpdir(), "agentengram-cli-project-"));
    const output: string[] = [];
    const io = { stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line) };

    expect(await runAdminCli(["setup", "pi", "--home", root, "--cwd", project], io)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ adapter: "pi", configuration: { config: { adapters: { pi: { mode: "enhance" } } } } });
    expect(JSON.parse(await readFile(join(project, ".agentengram", "config.json"), "utf8")))
      .toMatchObject({ adapters: { pi: { models: { compact: { strategy: "host-current" } } } } });
    expect(await runAdminCli(["doctor", "--adapter", "pi", "--home", root, "--cwd", project], io)).toBe(0);
    expect(JSON.parse(output.pop()!).checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "adapter-pi", status: "ok" }),
    ]));
    expect(await runAdminCli(["init", "codex", "--home", root, "--cwd", project], io)).toBe(0);
    expect(JSON.parse(await readFile(join(project, ".agentengram", "config.json"), "utf8"))).toMatchObject({
      adapters: {
        pi: { models: { formation: { strategy: "host-current" } } },
        codex: { models: { formation: { strategy: "disabled" } } },
      },
    });
  });

  it("lists and explicitly retries durable dead letters", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-cli-"));
    const projectId = "p";
    const runtimeRoot = projectRuntimeRoot(root, projectId);
    await mkdir(runtimeRoot, { recursive: true });
    const jobs = new DurableJobRuntime({ databasePath: join(runtimeRoot, "memory-jobs.db"), handlers: {} });
    jobs.enqueue({ jobId: "dead", kind: "missing", partitionKey: projectId, payload: {} });
    await jobs.runReady();
    await jobs.close();
    const output: string[] = [];
    const io = { stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line) };

    expect(await runAdminCli(["jobs", "list", "--home", root, "--cwd", root, "--project-id", projectId], io)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject([{ jobId: "dead", status: "dead_letter" }]);
    expect(await runAdminCli(["jobs", "retry", "dead", "--home", root, "--cwd", root, "--project-id", projectId], io)).toBe(0);
    expect(JSON.parse(output.pop()!)).toEqual({ jobId: "dead", retried: true });
  });

  it("verifies transcript truth and rebuilds FTS from Markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-cli-"));
    const projectId = "p";
    const transcripts = new TranscriptStore({ rootDir: projectStorageRoot(root, projectId) });
    await transcripts.appendRaw({
      schemaVersion: 1, id: "raw-1", framework: "test", frameworkSessionId: "s1", frameworkThreadId: "t1",
      eventType: "message.created", role: "user", timestamp: "2026-07-19T00:00:00.000Z", content: { text: "hello" },
      contentHash: "hash", sourceRef: "agentengram://transcript/s1/t1/raw-1",
    });
    transcripts.close();
    const store = new MarkdownMemoryStore(root);
    await store.put(createMemoryRecord({
      id: "memory-1", name: "Package manager", description: "Project convention", content: "Use pnpm.",
      type: "project", scope: "project", projectId, partition: { schemaVersion: 1, projectId },
    }));
    const output: string[] = [];
    const io = { stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line) };
    const common = ["--home", root, "--cwd", root, "--project-id", projectId];

    expect(await runAdminCli(["transcript", "verify", "--session", "s1", ...common], io)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ valid: true, sessions: [{ rawRecords: 1 }] });
    expect(await runAdminCli(["index", "rebuild", ...common], io)).toBe(0);
    expect(JSON.parse(output.pop()!)).toEqual({ rebuiltRecords: 1 });
    const index = new SqliteFtsMemoryIndex(join(root, "indexes", "memory.db"));
    expect(index.search({ text: "pnpm", projectId })).toHaveLength(1);
    index.close();
  });

  it("keeps transcript verify read-only and requires an explicit repair", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-cli-repair-"));
    const projectId = "p";
    const path = join(projectStorageRoot(root, projectId), "transcripts", "s1", "raw.jsonl");
    await mkdir(dirname(path), { recursive: true });
    const valid = JSON.stringify({
      schemaVersion: 1, id: "raw-1", framework: "test", frameworkSessionId: "s1", frameworkThreadId: "t1",
      eventType: "message.created", role: "user", timestamp: "2026-07-19T00:00:00.000Z", contentHash: "hash",
      sourceRef: "agentengram://transcript/s1/t1/raw-1",
    });
    await writeFile(path, `${valid}\n{\"broken\":`, "utf8");
    const output: string[] = [];
    const io = { stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line) };
    const common = ["--home", root, "--cwd", root, "--project-id", projectId, "--session", "s1"];

    expect(await runAdminCli(["transcript", "verify", ...common], io)).toBe(2);
    expect(await readFile(path, "utf8")).toBe(`${valid}\n{\"broken\":`);
    expect(await runAdminCli(["transcript", "repair", ...common], io)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ valid: true, sessions: [{ repaired: true }] });
    expect(await readFile(path, "utf8")).toBe(`${valid}\n`);
  });

  it("exports, imports, lists bindings, and requires confirmation before purge", async () => {
    const source = await mkdtemp(join(tmpdir(), "agentengram-cli-source-"));
    const target = await mkdtemp(join(tmpdir(), "agentengram-cli-target-"));
    const bundleContainer = await mkdtemp(join(tmpdir(), "agentengram-cli-bundle-"));
    const bundle = join(bundleContainer, "export");
    const projectId = "portable";
    const projectRoot = projectStorageRoot(source, projectId);
    await new MarkdownMemoryStore(source).put(createMemoryRecord({
      id: "portable-memory", name: "Portable", description: "Bundle memory", content: "portable bundle truth",
      type: "project", scope: "project", projectId, partition: { schemaVersion: 1, projectId },
    }));
    const output: string[] = [];
    const io = { stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line) };
    const sourceArgs = ["--home", source, "--cwd", source, "--project-id", projectId];

    expect(await runAdminCli([
      "bindings", "rebind",
      "--host-type", "pi", "--host-project", projectId, "--host-session", "s1", "--host-thread", "t1",
      "--namespace", projectId, "--thread", "portable-thread", ...sourceArgs,
    ], io)).toBe(0);
    expect(await runAdminCli(["bindings", "list", ...sourceArgs], io)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject([{ namespaceId: projectId, threadId: "portable-thread" }]);
    expect(await runAdminCli(["data", "export", "--output", bundle, ...sourceArgs], io)).toBe(0);
    expect(await runAdminCli(["data", "import", "--input", bundle, "--home", target, "--cwd", target], io)).toBe(0);
    await expect(stat(join(projectStorageRoot(target, projectId), "project", "portable-memory.md"))).resolves.toBeDefined();
    expect(await runAdminCli(["data", "purge", "--dry-run", ...sourceArgs], io)).toBe(0);
    await expect(stat(projectRoot)).resolves.toBeDefined();
    expect(await runAdminCli(["data", "purge", ...sourceArgs], io)).toBe(1);
    expect(await runAdminCli(["data", "purge", "--yes", ...sourceArgs], io)).toBe(0);
    await expect(stat(projectRoot)).rejects.toThrow();
  });

  it("applies configured transcript retention with dry-run and confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-cli-retention-"));
    const cwd = await mkdtemp(join(tmpdir(), "agentengram-cli-retention-project-"));
    const projectId = "retained-project";
    const session = join(projectStorageRoot(root, projectId), "transcripts", "old-session");
    await mkdir(session, { recursive: true });
    await writeFile(join(session, "raw.jsonl"), "", "utf8");
    const old = new Date("2025-01-01T00:00:00.000Z");
    await utimes(session, old, old);
    await mkdir(join(cwd, ".agentengram"), { recursive: true });
    await writeFile(join(cwd, ".agentengram", "config.json"), `${JSON.stringify({
      schemaVersion: 1, retention: { transcriptDays: 30 },
    })}\n`, "utf8");
    const output: string[] = [];
    const io = { stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line) };
    const common = ["--home", root, "--cwd", cwd, "--project-id", projectId];

    expect(await runAdminCli(["data", "prune", "--dry-run", ...common], io)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ days: 30, sessions: ["old-session"] });
    await expect(stat(session)).resolves.toBeDefined();
    expect(await runAdminCli(["data", "prune", "--yes", ...common], io)).toBe(0);
    await expect(stat(session)).rejects.toThrow();
  });
});
