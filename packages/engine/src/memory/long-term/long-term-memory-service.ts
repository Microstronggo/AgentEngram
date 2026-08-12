import type { MemoryFormationPipeline, MemoryObservation, FormationResult } from "./formation/memory-formation.js";
import { MemoryRecallService, type MemoryRecallResult, type RecallRequest } from "./recall/memory-recall.js";
import type { SqliteFtsMemoryIndex } from "./recall/sqlite-fts-index.js";
import { createMemoryRecord, type MemoryRecord, type MemoryScope, type NewMemoryRecord } from "./records/memory-record.js";
import type { MemoryUsageSource } from "./recall/memory-usage-store.js";

/** Markdown truth-store operations required by the long-term service. */
export interface LongTermMemoryStore {
  put(record: MemoryRecord): Promise<void>;
  get(scope: MemoryScope, id: string, projectId?: string): Promise<MemoryRecord | null>;
  list(scope: MemoryScope, projectId?: string): Promise<MemoryRecord[]>;
}

/** Public explicit Remember/Search/Forget surface. Markdown is truth; FTS5 is a rebuildable projection. */
export class LongTermMemoryService {
  /** Ranked read side over the rebuildable FTS index. */
  private readonly recallService: MemoryRecallService;

  /**
   * @param store Durable Markdown source of truth.
   * @param index Rebuildable FTS5 projection.
   * @param formation Optional automatic memory-formation pipeline.
   * @param clock Injectable record timestamp source.
   */
  public constructor(
    private readonly store: LongTermMemoryStore,
    private readonly index: SqliteFtsMemoryIndex,
    private readonly formation?: MemoryFormationPipeline,
    private readonly clock: () => Date = () => new Date(),
    usage?: MemoryUsageSource,
  ) {
    this.recallService = new MemoryRecallService(index, usage);
  }

  public async remember(input: NewMemoryRecord): Promise<MemoryRecord> {
    const record = createMemoryRecord(input, this.clock());
    await this.persist(record);
    return record;
  }

  public async form(observation: MemoryObservation): Promise<readonly FormationResult[]> {
    if (!this.formation) throw new Error("memory formation pipeline is not configured");
    const result = await this.formation.form(observation);
    for (const item of result) if (item.status === "written") {
      if (item.supersededRecord) await this.persist(item.supersededRecord);
      await this.persist(item.record);
    }
    return result;
  }

  public search(request: RecallRequest): MemoryRecallResult {
    return this.recallService.recall(request);
  }

  /** Forget archives evidence instead of erasing provenance. */
  public async forget(scope: MemoryScope, id: string, projectId?: string): Promise<boolean> {
    const record = await this.store.get(scope, id, projectId);
    if (!record) return false;
    await this.persist({ ...record, status: "archived", updatedAt: this.clock().toISOString() });
    return true;
  }

  public async rebuildIndex(scopes: readonly { scope: MemoryScope; projectId?: string }[]): Promise<number> {
    let count = 0;
    for (const location of scopes) {
      for (const record of await this.store.list(location.scope, location.projectId)) {
        this.index.upsert(record);
        count++;
      }
    }
    return count;
  }

  private async persist(record: MemoryRecord): Promise<void> {
    await this.store.put(record);
    this.index.upsert(record);
  }
}
