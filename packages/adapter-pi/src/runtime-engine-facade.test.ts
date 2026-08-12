import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalAgentEngramRuntime,
  resolveProjectIdentity,
  type CompactSummarizer,
} from "@agentengram/engine";
import {
  createLocalRuntimeEngineFacade,
  createRuntimeEngineFacade,
} from "./runtime-engine-facade.js";

const summarizer: CompactSummarizer = {
  summarize: vi.fn(async ({ messages }) => ({
    text: `managed summary for ${messages.map((message) => message.id).join(",")}`,
    model: "qwen-current",
  })),
};

const runtimes: LocalAgentEngramRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.clearAllMocks();
});

describe("RuntimeEngineFacade", () => {
  it("bridges managed compaction to LocalAgentEngramRuntime", async () => {
    const homeDir = await temporaryDirectory("agentengram-pi-compact-home-");
    const runtime = await LocalAgentEngramRuntime.create({
      homeDir,
      projectId: "project-a",
      summarizer,
    });
    runtimes.push(runtime);
    const facade = createRuntimeEngineFacade(runtime);
    expect(facade.managedContextReady).toBe(true);

    const result = await facade.compact({
      mode: "managed-context",
      preparation: {
        firstKeptEntryId: "entry-3",
        settings: { keepRecentTokens: 1 },
      },
      branchEntries: [
        { id: "entry-1", type: "message" },
        { id: "entry-2", type: "message" },
        { id: "entry-3", type: "message" },
      ],
      signal: new AbortController().signal,
      cwd: await temporaryDirectory("agentengram-pi-compact-cwd-"),
      sessionId: "session-a",
      threadId: "thread-a",
      canonicalMessages: [
        piMessage("m1", "older project decision"),
        piMessage("m2", "older failed command"),
        piMessage("m3", "recent request"),
      ],
    });

    expect(result).toMatchObject({
      summary: "managed summary for m1,m2",
      firstKeptEntryId: "entry-3",
      details: {
        agentengram: {
          summaryModel: "qwen-current",
        },
      },
    });
    expect(result?.tokensBefore).toBeGreaterThan(0);
    expect(summarizer.summarize).toHaveBeenCalledOnce();
  });

  it("marks local managed context ready when the host-current bridge or a summarizer is available", () => {
    expect(createLocalRuntimeEngineFacade().managedContextReady).toBe(true);
    expect(createLocalRuntimeEngineFacade({ useHostCurrentModel: false }).managedContextReady).toBe(false);
    expect(createLocalRuntimeEngineFacade({ summarizer }).managedContextReady).toBe(true);
  });

  it("persists an exact Pi HostBinding and restores its namespace after restart", async () => {
    const homeDir = await temporaryDirectory("agentengram-pi-binding-home-");
    const cwd = await temporaryDirectory("agentengram-pi-binding-cwd-");
    const first = createLocalRuntimeEngineFacade({
      homeDir,
      namespaceId: "portable-shared-namespace",
      useHostCurrentModel: false,
    });

    await first.recordTranscript({
      cwd,
      sessionId: "session-a",
      threadId: "thread-a",
      branchEntries: [{
        id: "entry-1",
        type: "message",
        message: { id: "message-1", role: "user", content: "remember me", timestamp: 1 },
      }],
      reason: "context",
    });
    const original = await first.resolveHostBinding({ cwd, sessionId: "session-a", threadId: "thread-a" });
    await first.close();

    // A changed default must not rewrite an existing exact mapping.
    const restarted = createLocalRuntimeEngineFacade({
      homeDir,
      namespaceId: "different-default",
      useHostCurrentModel: false,
    });
    const restored = await restarted.resolveHostBinding({ cwd, sessionId: "session-a", threadId: "thread-a" });
    const otherThread = await restarted.resolveHostBinding({ cwd, sessionId: "session-a", threadId: "thread-b" });
    await restarted.close();

    expect(restored).toEqual(original);
    expect(restored.namespaceId).toBe("portable-shared-namespace");
    expect(otherThread).toMatchObject({ namespaceId: "different-default", threadId: "thread-b" });
  });

  it("persists a compact ownership fallback in the project Projection Log", async () => {
    const homeDir = await temporaryDirectory("agentengram-pi-ownership-home-");
    const cwd = await temporaryDirectory("agentengram-pi-ownership-cwd-");
    const facade = createLocalRuntimeEngineFacade({ homeDir, useHostCurrentModel: false });
    await facade.recordOwnershipFallback({
      cwd,
      sessionId: "session-a",
      threadId: "thread-a",
      reason: "compact-failed",
      ownership: {
        requestedMode: "managed-context",
        effectiveMode: "managed-context",
        contextOwner: "agentengram",
        compactionOwner: "agentengram",
        failurePolicy: "host-fallback",
        fallbackCount: 0,
      },
    });
    const project = await resolveProjectIdentity(cwd);
    const log = await readFile(join(
      homeDir,
      "projects",
      project.projectId,
      "threads",
      "session-a",
      "thread-a",
      "projection.jsonl",
    ), "utf8");
    await facade.close();

    expect(log).toContain("context.ownership-fallback");
    expect(log).toContain("compact-failed");
  });
});

function piMessage(id: string, text: string) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.parse("2026-06-24T00:00:00.000Z"),
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
