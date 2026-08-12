import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { DurableJobRuntime } from "./durable-job-runtime.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("DurableJobRuntime", () => {
  it("deduplicates enqueue and retries failed work after persisted backoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-jobs-")); roots.push(root);
    let now = new Date("2026-07-06T00:00:00.000Z");
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValue(undefined);
    const runtime = new DurableJobRuntime({
      databasePath: join(root, "jobs.db"), handlers: { formation: handler }, clock: () => now, retryBaseDelayMs: 1_000,
    });
    runtime.enqueue({ jobId: "cell-1", kind: "formation", partitionKey: "p", payload: { cellId: "c" } });
    runtime.enqueue({ jobId: "cell-1", kind: "formation", partitionKey: "p", payload: { cellId: "c" } });
    await runtime.runReady();
    expect(runtime.get("cell-1")).toMatchObject({ status: "pending", attempts: 1 });
    now = new Date("2026-07-06T00:00:02.000Z");
    await runtime.runReady();
    expect(runtime.get("cell-1")).toMatchObject({ status: "completed", attempts: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it("moves unknown job kinds to dead letter and supports explicit replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-jobs-")); roots.push(root);
    const runtime = new DurableJobRuntime({ databasePath: join(root, "jobs.db"), handlers: {} });
    runtime.enqueue({ jobId: "bad", kind: "unknown", partitionKey: "p", payload: {} });
    await runtime.runReady();
    expect(runtime.get("bad")?.status).toBe("dead_letter");
    expect(runtime.retry("bad")).toBe(true);
    expect(runtime.get("bad")?.status).toBe("pending");
    await runtime.close();
  });

  it("claims one job once across two worker instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-jobs-")); roots.push(root);
    const path = join(root, "jobs.db");
    const handler = vi.fn(async () => { await delay(25); });
    const first = new DurableJobRuntime({ databasePath: path, handlers: { formation: handler }, workerId: "first" });
    const second = new DurableJobRuntime({ databasePath: path, handlers: { formation: handler }, workerId: "second" });
    first.enqueue({ jobId: "shared", kind: "formation", partitionKey: "p", payload: {} });
    await Promise.all([first.runReady(), second.runReady()]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.get("shared")?.status).toBe("completed");
    await first.close();
    await second.close();
  });

  it("renews a lease while a long handler is running", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-jobs-")); roots.push(root);
    const path = join(root, "jobs.db");
    const firstHandler = vi.fn(async () => { await delay(140); });
    const secondHandler = vi.fn(async () => undefined);
    const first = new DurableJobRuntime({
      databasePath: path, handlers: { formation: firstHandler }, workerId: "first", leaseMs: 45, heartbeatIntervalMs: 10,
    });
    const second = new DurableJobRuntime({
      databasePath: path, handlers: { formation: secondHandler }, workerId: "second", leaseMs: 45, heartbeatIntervalMs: 10,
    });
    first.enqueue({ jobId: "slow", kind: "formation", partitionKey: "p", payload: {} });
    const running = first.runReady();
    await delay(80);
    await second.runReady();
    await running;
    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).not.toHaveBeenCalled();
    expect(first.get("slow")?.status).toBe("completed");
    await first.close();
    await second.close();
  });

  it("recovers an expired peer lease during polling without a new hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-jobs-")); roots.push(root);
    const path = join(root, "jobs.db");
    const handler = vi.fn(async () => undefined);
    const worker = new DurableJobRuntime({ databasePath: path, handlers: { formation: handler }, pollIntervalMs: 25 });
    worker.start();
    const database = new Database(path);
    const now = new Date();
    database.prepare(`INSERT INTO memory_jobs(job_id, kind, partition_key, payload, status, attempts, next_run_at,
      lease_owner, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'processing', 0, ?, ?, ?, ?, ?)`)
      .run("orphan", "formation", "p", "{}", now.toISOString(), "dead-worker", new Date(now.getTime() - 1_000).toISOString(), now.toISOString(), now.toISOString());
    database.close();
    await waitUntil(() => worker.get("orphan")?.status === "completed");
    expect(handler).toHaveBeenCalledTimes(1);
    await worker.close();
  });

  it("aborts an active handler during close", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-jobs-")); roots.push(root);
    let observedSignal: AbortSignal | undefined;
    const runtime = new DurableJobRuntime({
      databasePath: join(root, "jobs.db"),
      handlers: { formation: async (_job, signal) => {
        observedSignal = signal;
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      } },
    });
    runtime.enqueue({ jobId: "active", kind: "formation", partitionKey: "p", payload: {} });
    void runtime.runReady();
    await waitUntil(() => observedSignal !== undefined);
    await runtime.close();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("resumes a persisted retry after runtime restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-jobs-")); roots.push(root);
    const path = join(root, "jobs.db");
    const first = new DurableJobRuntime({
      databasePath: path, handlers: { formation: async () => { throw new Error("temporary"); } }, retryBaseDelayMs: 10,
    });
    first.enqueue({ jobId: "restart", kind: "formation", partitionKey: "p", payload: {} });
    await first.runReady();
    expect(first.get("restart")).toMatchObject({ status: "pending", attempts: 1 });
    await first.close();
    await delay(20);
    const handler = vi.fn(async () => undefined);
    const resumed = new DurableJobRuntime({ databasePath: path, handlers: { formation: handler }, pollIntervalMs: 25 });
    resumed.start();
    await waitUntil(() => resumed.get("restart")?.status === "completed");
    expect(handler).toHaveBeenCalledTimes(1);
    await resumed.close();
  });

  it("times out drain while a peer owns an active lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-jobs-")); roots.push(root);
    const path = join(root, "jobs.db");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const owner = new DurableJobRuntime({ databasePath: path, handlers: { formation: async () => gate }, leaseMs: 100, heartbeatIntervalMs: 20 });
    const observer = new DurableJobRuntime({ databasePath: path, handlers: { formation: async () => undefined } });
    owner.enqueue({ jobId: "leased", kind: "formation", partitionKey: "p", payload: {} });
    const running = owner.runReady();
    await waitUntil(() => owner.get("leased")?.status === "processing");
    await expect(observer.drain({ timeoutMs: 20 })).resolves.toBe("timeout");
    release();
    await running;
    await owner.close();
    await observer.close();
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await delay(10);
  }
}
