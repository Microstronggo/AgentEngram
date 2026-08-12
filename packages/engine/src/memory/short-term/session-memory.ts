/** Compact record of commands run and whether the latest verification passed. */
export interface VerificationState {
  readonly status: "not-run" | "passed" | "failed" | "partial";
  readonly checks: readonly string[];
  readonly details?: string;
}

/** Structured task state preserved independently from conversational history. */
export interface SessionMemory {
  readonly version: 1;
  readonly updatedAt: string;
  readonly summarizedThroughEventId?: string;
  readonly goals: readonly string[];
  readonly constraints: readonly string[];
  readonly decisions: readonly string[];
  readonly activeFiles: readonly string[];
  readonly completedWork: readonly string[];
  readonly failedAttempts: readonly string[];
  readonly pendingTasks: readonly string[];
  readonly blockers: readonly string[];
  readonly verificationState: VerificationState;
}

/** Partial extractor update merged into the latest durable session memory. */
export type SessionMemoryPatch = Partial<Omit<SessionMemory, "version" | "updatedAt">>;

/** Model or deterministic extractor that updates structured task state. */
export interface SessionMemoryExtractor<TMessage = unknown> {
  extract(input: {
    readonly messages: readonly TMessage[];
    readonly previous?: SessionMemory;
    readonly signal?: AbortSignal;
  }): Promise<SessionMemoryPatch>;
}

/** Persistence is injected so runtimes can use checkpoint files, SQLite, or framework storage. */
/** Durable per-session snapshot store used by compaction and rehydration. */
export interface SessionMemoryRepository {
  load(sessionId: string): Promise<SessionMemory | undefined>;
  save(sessionId: string, memory: SessionMemory): Promise<void>;
}

/** Returns a schema-valid empty task-state snapshot. */
export function emptySessionMemory(now = new Date()): SessionMemory {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    goals: [], constraints: [], decisions: [], activeFiles: [], completedWork: [], failedAttempts: [],
    pendingTasks: [], blockers: [], verificationState: { status: "not-run", checks: [] },
  };
}

/** Merges an extractor patch without discarding previously known task state. */
export function updateSessionMemory(
  previous: SessionMemory | undefined,
  patch: SessionMemoryPatch,
  now = new Date(),
): SessionMemory {
  const base = previous ?? emptySessionMemory(now);
  return {
    ...base,
    ...patch,
    version: 1,
    updatedAt: now.toISOString(),
    goals: unique(patch.goals ?? base.goals),
    constraints: unique(patch.constraints ?? base.constraints),
    decisions: unique(patch.decisions ?? base.decisions),
    activeFiles: unique(patch.activeFiles ?? base.activeFiles),
    completedWork: unique(patch.completedWork ?? base.completedWork),
    failedAttempts: unique(patch.failedAttempts ?? base.failedAttempts),
    pendingTasks: unique(patch.pendingTasks ?? base.pendingTasks),
    blockers: unique(patch.blockers ?? base.blockers),
  };
}

/** Runs the configured extractor against messages and the previous durable snapshot. */
export async function extractSessionMemory<TMessage>(
  extractor: SessionMemoryExtractor<TMessage>,
  messages: readonly TMessage[],
  previous?: SessionMemory,
  options: { readonly now?: Date; readonly signal?: AbortSignal } = {},
): Promise<SessionMemory> {
  const patch = await extractor.extract({
    messages,
    ...(previous === undefined ? {} : { previous }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return updateSessionMemory(previous, patch, options.now);
}

/** Extracts and delegates persistence to the configured repository. */
export async function extractAndSaveSessionMemory<TMessage>(input: {
  readonly sessionId: string;
  readonly messages: readonly TMessage[];
  readonly extractor: SessionMemoryExtractor<TMessage>;
  readonly repository: SessionMemoryRepository;
  readonly now?: Date;
  readonly signal?: AbortSignal;
}): Promise<SessionMemory> {
  const previous = await input.repository.load(input.sessionId);
  const memory = await extractSessionMemory(input.extractor, input.messages, previous, {
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  await input.repository.save(input.sessionId, memory);
  return memory;
}

/** Forks inherit a value snapshot; later child updates cannot mutate the parent. */
export function forkSessionMemory(parent: SessionMemory, now = new Date()): SessionMemory {
  return structuredClone({ ...parent, updatedAt: now.toISOString() });
}

/** Renders structured task state as a model-visible Markdown block. */
export function renderSessionMemory(memory: SessionMemory): string {
  const sections: [string, readonly string[]][] = [
    ["Goals", memory.goals], ["Constraints", memory.constraints], ["Decisions", memory.decisions],
    ["Active files", memory.activeFiles], ["Completed", memory.completedWork], ["Failed attempts", memory.failedAttempts],
    ["Pending", memory.pendingTasks], ["Blockers", memory.blockers],
  ];
  return sections.map(([title, values]) => `## ${title}\n${values.length ? values.map((v) => `- ${v}`).join("\n") : "- None"}`).join("\n\n");
}

const unique = (values: readonly string[]): readonly string[] => [...new Set(values.map((v) => v.trim()).filter(Boolean))];
