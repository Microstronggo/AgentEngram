import { describe, expect, it, vi } from "vitest";
import { WorkerExecutionRunner } from "./worker-execution.js";

describe("WorkerExecutionRunner", () => {
  it("starts an embedded worker without requiring a process launcher", async () => {
    const start = vi.fn();
    await expect(new WorkerExecutionRunner({ mode: "embedded", embedded: { start } }).ensureAvailable())
      .resolves.toEqual({ mode: "embedded", action: "started-embedded" });
    expect(start).toHaveBeenCalledOnce();
  });

  it("delegates sidecar wake-up to an adapter-owned launcher", async () => {
    const ensureRunning = vi.fn(async () => undefined);
    await expect(new WorkerExecutionRunner({ mode: "sidecar", sidecar: { ensureRunning } }).ensureAvailable())
      .resolves.toEqual({ mode: "sidecar", action: "requested-sidecar" });
    expect(ensureRunning).toHaveBeenCalledOnce();
  });

  it("leaves externally managed workers untouched and rejects missing dependencies", async () => {
    await expect(new WorkerExecutionRunner({ mode: "external" }).ensureAvailable())
      .resolves.toEqual({ mode: "external", action: "externally-managed" });
    await expect(new WorkerExecutionRunner({ mode: "embedded" }).ensureAvailable()).rejects.toThrow("embedded worker");
    await expect(new WorkerExecutionRunner({ mode: "sidecar" }).ensureAvailable()).rejects.toThrow("sidecar launcher");
  });
});
