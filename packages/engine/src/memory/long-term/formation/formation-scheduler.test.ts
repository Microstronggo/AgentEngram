import { describe, expect, it } from "vitest";
import type { MemoryFormationPipeline, MemoryObservation } from "./memory-formation.js";
import {
  FormationScheduler,
  InProcessRestrictedFormationExecutor,
  createRestrictedFormationPolicy,
  withManifestPreInjection,
  type FormationCursorStore,
} from "./formation-scheduler.js";

describe("FormationScheduler", () => {
  it("advances cursor only after a successful extraction batch", async () => {
    const cursor = new MemoryCursor();
    const pipeline = new CapturingPipeline();
    const scheduler = new FormationScheduler({ pipeline, cursorStore: cursor });

    await expect(scheduler.schedule({ cursor: "c1", observations: [observation("first")] }))
      .resolves.toMatchObject({ status: "completed", cursor: "c1", processed: 1 });
    expect(await cursor.load()).toBe("c1");

    pipeline.failNext = new Error("extractor failed");
    await expect(scheduler.schedule({ cursor: "c2", observations: [observation("second")] }))
      .resolves.toMatchObject({ status: "failed", cursor: "c2" });
    expect(await cursor.load()).toBe("c1");
  });

  it("keeps only the latest trailing request while a run is in flight", async () => {
    const cursor = new MemoryCursor();
    const gate = createGate();
    const pipeline = new CapturingPipeline(async (item) => {
      if (item.text === "running") await gate.promise;
    });
    const scheduler = new FormationScheduler({ pipeline, cursorStore: cursor });

    const first = scheduler.schedule({ cursor: "c1", observations: [observation("running")] });
    const superseded = scheduler.schedule({ cursor: "c2", observations: [observation("stale")] });
    const latest = scheduler.schedule({ cursor: "c3", observations: [observation("latest")] });

    await expect(superseded).resolves.toMatchObject({ status: "skipped", skipped: 1 });
    gate.resolve();
    await expect(first).resolves.toMatchObject({ status: "completed", cursor: "c3" });
    await expect(latest).resolves.toMatchObject({ status: "completed", cursor: "c3" });
    expect(pipeline.texts).toEqual(["running", "latest"]);
    expect(await cursor.load()).toBe("c3");
  });

  it("drains in-flight work with a soft timeout", async () => {
    const gate = createGate();
    const pipeline = new CapturingPipeline(() => gate.promise);
    const scheduler = new FormationScheduler({ pipeline });

    const active = scheduler.schedule({ cursor: "c1", observations: [observation("slow")] });
    await expect(scheduler.drain({ timeoutMs: 1 })).resolves.toBe("timeout");
    gate.resolve();
    await active;
    await expect(scheduler.drain()).resolves.toBe("drained");
    await expect(scheduler.schedule({ cursor: "c2", observations: [observation("ignored")] }))
      .resolves.toMatchObject({ status: "skipped", skipped: 1 });
  });

  it("skips background extraction when the main agent already wrote memory", async () => {
    const cursor = new MemoryCursor();
    const pipeline = new CapturingPipeline();
    const scheduler = new FormationScheduler({ pipeline, cursorStore: cursor });

    await expect(scheduler.schedule({
      cursor: "c1",
      observations: [{ ...observation("explicit remember"), alreadyWrittenByAgent: true }],
    })).resolves.toMatchObject({ status: "skipped", processed: 0, skipped: 1, cursor: "c1" });

    expect(pipeline.texts).toEqual([]);
    expect(await cursor.load()).toBe("c1");
  });

  it("exposes a restricted executor policy for background formation", async () => {
    expect(createRestrictedFormationPolicy("/tmp/memory")).toEqual({
      allowRead: true,
      memoryWriteRoot: "/tmp/memory",
      allowShell: false,
      allowMcp: false,
      allowAgentSpawn: false,
    });

    const executor = new InProcessRestrictedFormationExecutor("/tmp/memory");
    const pipeline = new CapturingPipeline();
    const scheduler = new FormationScheduler({ pipeline, restrictedExecutor: executor });

    await scheduler.schedule({ cursor: "c1", observations: [observation("under policy")] });
    expect(executor.policy.allowShell).toBe(false);
    expect(pipeline.texts).toEqual(["under policy"]);
  });

  it("pre-injects memory manifest before extractor input", async () => {
    const injected = withManifestPreInjection({
      ...observation("new transcript"),
      manifest: {
        memoryIndex: "- [Project decisions](project/decisions.md)",
        headers: ["## Conventions", "## Failures"],
      },
    });

    expect(injected.text).toContain("# MEMORY.md");
    expect(injected.text).toContain("Project decisions");
    expect(injected.text).toContain("# Existing memory headers");
    expect(injected.text).toContain("new transcript");
    expect(injected.metadata).toMatchObject({ manifestPreInjected: true });
  });
});

class MemoryCursor implements FormationCursorStore {
  value: string | undefined;
  async load(): Promise<string | undefined> {
    return this.value;
  }
  async save(cursor: string): Promise<void> {
    this.value = cursor;
  }
}

class CapturingPipeline {
  texts: string[] = [];
  failNext: unknown;
  constructor(private readonly onForm?: (observation: MemoryObservation) => Promise<void>) {}
  async form(observation: MemoryObservation) {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    await this.onForm?.(observation);
    this.texts.push(observation.text);
    return [];
  }
}

function observation(text: string): MemoryObservation {
  return { text, sourceRefs: [`ref:${text}`], projectId: "agentengram" };
}

function createGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
