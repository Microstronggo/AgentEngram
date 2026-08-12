/** Process topology used to execute durable model-backed memory jobs. */
export type WorkerExecutionMode = "embedded" | "sidecar" | "external";

/** Minimal embedded scheduler boundary implemented by DurableJobRuntime. */
export interface EmbeddedWorker {
  start(): void;
}

/** Adapter-owned launcher for a short-lived, lease-protected worker process. */
export interface SidecarWorkerLauncher {
  ensureRunning(): Promise<void>;
}

/** Observable result of ensuring the configured worker topology is available. */
export interface WorkerExecutionResult {
  readonly mode: WorkerExecutionMode;
  readonly action: "started-embedded" | "requested-sidecar" | "externally-managed";
}

/** Dependencies for framework-neutral worker topology selection. */
export interface WorkerExecutionRunnerOptions {
  readonly mode: WorkerExecutionMode;
  readonly embedded?: EmbeddedWorker;
  readonly sidecar?: SidecarWorkerLauncher;
}

/**
 * Selects how an adapter wakes durable work without duplicating queue, retry,
 * or lease semantics already owned by DurableJobRuntime.
 */
export class WorkerExecutionRunner {
  public constructor(private readonly options: WorkerExecutionRunnerOptions) {}

  /** Ensures work can run while keeping external workers adapter-independent. */
  public async ensureAvailable(): Promise<WorkerExecutionResult> {
    switch (this.options.mode) {
      case "embedded":
        if (!this.options.embedded) throw new Error("embedded worker execution requires an embedded worker");
        this.options.embedded.start();
        return { mode: "embedded", action: "started-embedded" };
      case "sidecar":
        if (!this.options.sidecar) throw new Error("sidecar worker execution requires a sidecar launcher");
        await this.options.sidecar.ensureRunning();
        return { mode: "sidecar", action: "requested-sidecar" };
      case "external":
        // External deployment owns wake-up and lifecycle. Engine still writes
        // the same durable queue, so no local process action is appropriate.
        return { mode: "external", action: "externally-managed" };
    }
  }
}
