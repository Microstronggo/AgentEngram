import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

/** Persistent lifecycle states for model-backed background work. */
export type DurableJobStatus = "pending" | "processing" | "completed" | "dead_letter";

/** Durable work item; payloads contain references/identities rather than transcript bodies. */
export interface DurableMemoryJob<T = unknown> {
  readonly jobId: string;
  readonly kind: string;
  readonly partitionKey: string;
  readonly payload: T;
  readonly status: DurableJobStatus;
  readonly attempts: number;
  readonly nextRunAt: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Handler result can defer useful work without counting it as a provider failure. */
export type DurableJobHandler = (job: DurableMemoryJob, signal: AbortSignal) => Promise<void>;

export interface DurableJobRuntimeOptions {
  readonly databasePath: string;
  readonly handlers: Readonly<Record<string, DurableJobHandler>>;
  readonly workerId?: string;
  readonly pollIntervalMs?: number;
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
  /** Lease renewal cadence; defaults to one third of leaseMs. */
  readonly heartbeatIntervalMs?: number;
  readonly clock?: () => Date;
}

/** SQLite-backed scheduler with leases, restart recovery, backoff, and dead letters. */
export class DurableJobRuntime {
  private readonly database: Database.Database;
  private readonly workerId: string;
  private readonly clock: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Active handler controllers let shutdown abort providers that honor signals. */
  private readonly controllers = new Map<string, AbortController>();

  public constructor(private readonly options: DurableJobRuntimeOptions) {
    this.workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
    this.clock = options.clock ?? (() => new Date());
    this.database = new Database(options.databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memory_jobs (
        job_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        partition_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        next_run_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_jobs_ready ON memory_jobs(status, next_run_at);
    `);
    this.recoverExpiredLeases();
  }

  /** Enqueues an idempotent job; a completed job with the same id remains completed. */
  public enqueue(input: {
    readonly jobId: string;
    readonly kind: string;
    readonly partitionKey: string;
    readonly payload: unknown;
    readonly nextRunAt?: Date;
  }): DurableMemoryJob {
    const now = this.clock().toISOString();
    this.database.prepare(`INSERT INTO memory_jobs(
      job_id, kind, partition_key, payload, status, attempts, next_run_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    ON CONFLICT(job_id) DO NOTHING`).run(
      input.jobId, input.kind, input.partitionKey, JSON.stringify(input.payload),
      input.nextRunAt?.toISOString() ?? now, now, now,
    );
    return this.get(input.jobId)!;
  }

  /** Starts a lightweight embedded worker; standalone processes can call runReady directly. */
  public start(): void {
    if (this.timer) return;
    const interval = Math.max(25, this.options.pollIntervalMs ?? 1_000);
    this.timer = setInterval(() => { void this.runReady(); }, interval);
    this.timer.unref?.();
    void this.runReady();
  }

  /** Claims and executes all currently ready jobs without overlapping poll iterations. */
  public async runReady(limit = 32): Promise<number> {
    if (this.running) return 0;
    // Recovery must run on every polling cycle. Constructor-only recovery would
    // strand work when a peer dies after all healthy workers have started.
    this.recoverExpiredLeases();
    this.running = true;
    let completed = 0;
    try {
      // Freeze the ready set at poll start. A fast backoff must never cause the
      // same failed job to be claimed twice inside one runReady() invocation.
      for (const jobId of this.readyJobIds(limit)) {
        const job = this.claim(jobId);
        if (!job) continue;
        await this.execute(job);
        completed++;
      }
      return completed;
    } finally {
      this.running = false;
    }
  }

  /** Runs one known job immediately when it is ready, useful for bounded hook drains and tests. */
  public async runJob(jobId: string): Promise<DurableMemoryJob | undefined> {
    this.recoverExpiredLeases();
    const job = this.claim(jobId);
    if (job) await this.execute(job);
    return this.get(jobId);
  }

  public get(jobId: string): DurableMemoryJob | undefined {
    const row = this.database.prepare("SELECT * FROM memory_jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
    return row ? decodeJob(row) : undefined;
  }

  public list(status?: DurableJobStatus): DurableMemoryJob[] {
    const rows = (status
      ? this.database.prepare("SELECT * FROM memory_jobs WHERE status = ? ORDER BY created_at").all(status)
      : this.database.prepare("SELECT * FROM memory_jobs ORDER BY created_at").all()) as JobRow[];
    return rows.map(decodeJob);
  }

  /** Explicitly replays a dead letter while retaining its attempt history. */
  public retry(jobId: string): boolean {
    const now = this.clock().toISOString();
    return this.database.prepare(`UPDATE memory_jobs SET status = 'pending', next_run_at = ?,
      lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ?
      WHERE job_id = ? AND status = 'dead_letter'`).run(now, now, jobId).changes === 1;
  }

  /** Waits for currently claimed work without waiting for future backoff times. */
  public async drain(options: { readonly timeoutMs?: number } = {}): Promise<"drained" | "timeout"> {
    const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
    while (this.running || this.processingCount() > 0) {
      if (deadline !== undefined && Date.now() >= deadline) return "timeout";
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return "drained";
  }

  public async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.controllers.values()) controller.abort(new DOMException("Durable job runtime is closing", "AbortError"));
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 5));
    this.database.close();
  }

  private readyJobIds(limit: number): readonly string[] {
    const boundedLimit = Math.max(0, Math.floor(limit));
    if (boundedLimit === 0) return [];
    const rows = this.database.prepare(`SELECT job_id FROM memory_jobs
      WHERE status = 'pending' AND next_run_at <= ? ORDER BY next_run_at, created_at LIMIT ?`)
      .all(this.clock().toISOString(), boundedLimit) as Array<{ job_id: string }>;
    return rows.map(({ job_id }) => job_id);
  }

  private claim(jobId: string): DurableMemoryJob | undefined {
    const now = this.clock();
    const expires = new Date(now.getTime() + this.leaseMs()).toISOString();
    const claimed = this.database.prepare(`UPDATE memory_jobs SET status = 'processing', lease_owner = ?,
      lease_expires_at = ?, updated_at = ? WHERE job_id = ? AND status = 'pending' AND next_run_at <= ?`)
      .run(this.workerId, expires, now.toISOString(), jobId, now.toISOString());
    return claimed.changes === 1 ? this.get(jobId) : undefined;
  }

  private async execute(job: DurableMemoryJob): Promise<void> {
    const handler = this.options.handlers[job.kind];
    if (!handler) {
      this.fail(job, new Error(`no durable job handler registered for ${job.kind}`), true);
      return;
    }
    const controller = new AbortController();
    this.controllers.set(job.jobId, controller);
    const heartbeatMs = Math.max(10, this.options.heartbeatIntervalMs ?? Math.floor(this.leaseMs() / 3));
    const heartbeat = setInterval(() => this.renewLease(job.jobId), heartbeatMs);
    heartbeat.unref?.();
    try {
      await handler(job, controller.signal);
      const now = this.clock().toISOString();
      this.database.prepare(`UPDATE memory_jobs SET status = 'completed', lease_owner = NULL,
        lease_expires_at = NULL, updated_at = ? WHERE job_id = ? AND lease_owner = ?`)
        .run(now, job.jobId, this.workerId);
    } catch (error) {
      this.fail(job, error, false);
    } finally {
      clearInterval(heartbeat);
      this.controllers.delete(job.jobId);
    }
  }

  private fail(job: DurableMemoryJob, error: unknown, permanent: boolean): void {
    const attempts = job.attempts + 1;
    const maxAttempts = Math.max(1, this.options.maxAttempts ?? 5);
    const dead = permanent || attempts >= maxAttempts;
    const delay = Math.max(1, this.options.retryBaseDelayMs ?? 1_000) * 2 ** Math.max(0, attempts - 1);
    const now = this.clock();
    const next = new Date(now.getTime() + delay).toISOString();
    this.database.prepare(`UPDATE memory_jobs SET status = ?, attempts = ?, next_run_at = ?,
      lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE job_id = ? AND lease_owner = ?`).run(
        dead ? "dead_letter" : "pending", attempts, next, errorMessage(error), now.toISOString(), job.jobId, this.workerId,
      );
  }

  private recoverExpiredLeases(): void {
    const now = this.clock().toISOString();
    this.database.prepare(`UPDATE memory_jobs SET status = 'pending', lease_owner = NULL,
      lease_expires_at = NULL, next_run_at = ?, updated_at = ?
      WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`).run(now, now, now);
  }

  private renewLease(jobId: string): void {
    const now = this.clock();
    const expires = new Date(now.getTime() + this.leaseMs()).toISOString();
    this.database.prepare(`UPDATE memory_jobs SET lease_expires_at = ?, updated_at = ?
      WHERE job_id = ? AND status = 'processing' AND lease_owner = ?`)
      .run(expires, now.toISOString(), jobId, this.workerId);
  }

  private leaseMs(): number {
    return Math.max(25, this.options.leaseMs ?? 60_000);
  }

  private processingCount(): number {
    return (this.database.prepare("SELECT COUNT(*) AS count FROM memory_jobs WHERE status = 'processing'").get() as { count: number }).count;
  }
}

interface JobRow {
  job_id: string; kind: string; partition_key: string; payload: string; status: DurableJobStatus;
  attempts: number; next_run_at: string; lease_owner: string | null; lease_expires_at: string | null;
  last_error: string | null; created_at: string; updated_at: string;
}

function decodeJob(row: JobRow): DurableMemoryJob {
  return {
    jobId: row.job_id, kind: row.kind, partitionKey: row.partition_key, payload: JSON.parse(row.payload) as unknown,
    status: row.status, attempts: row.attempts, nextRunAt: row.next_run_at, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
