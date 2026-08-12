import { createHash, randomUUID } from "node:crypto";
import type { MemoryObservation } from "./memory-formation.js";

/** Supported evidence-window shapes before long-term extraction. */
export const FORMATION_CELL_TYPES = ["turn", "episode", "tool", "compact-summary", "manual"] as const;
/** Supported evidence-window shape. */
export type FormationCellType = (typeof FORMATION_CELL_TYPES)[number];

/** Lifecycle causes that emit a FormationCell. */
export const FORMATION_TRIGGERS = ["turn", "session", "compact", "manual", "evaluation"] as const;
/** Lifecycle cause that emitted a FormationCell. */
export type FormationTrigger = (typeof FORMATION_TRIGGERS)[number];

/** Inclusive temporal span covered by a FormationCell's source evidence. */
export interface FormationCellTimestampRange {
  /** Inclusive ISO timestamp for the first source event represented by this cell. */
  readonly start: string;
  /** Inclusive ISO timestamp for the last source event represented by this cell. */
  readonly end: string;
}

/** Normalized source slice used to form long-term memory without owning the transcript. */
export interface FormationCell {
  /** Stable cell id derived from source ids and text for replayable formation. */
  readonly id: string;
  /** Project/worktree scope carried into MemoryObservation and MemoryRecord. */
  readonly projectId?: string;
  /** Conversation/session identifier for downstream grouping and evaluation. */
  readonly sessionId?: string;
  /** Optional branch/thread identifier for multi-agent or forked conversations. */
  readonly threadId?: string;
  /** Canonical transcript, compact, tool, or benchmark source ids preserved as provenance. */
  readonly sourceEntryIds: readonly string[];
  /** Coarse source shape that drives typed extraction policy. */
  readonly cellType: FormationCellType;
  /** Event that caused this cell to be emitted. */
  readonly trigger: FormationTrigger;
  /** Text window sent into the long-term memory formation pipeline. */
  readonly text: string;
  /** Optional temporal span represented by the source entries. */
  readonly timestampRange?: FormationCellTimestampRange;
  /** Adapter-specific metadata; must remain auxiliary and non-authoritative. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Deterministic identity override used by replay and evaluation. */
export interface FormationCellBuilderOptions {
  readonly idFactory?: (seed: string) => string;
}

/** Turn-shaped input assembled from user, assistant, and selected tool prose. */
export interface TurnCellInput extends BaseCellInput {
  readonly text?: string;
  readonly userText?: string;
  readonly assistantText?: string;
  readonly toolText?: string;
}

/** Preassembled evidence text used by episode, tool, compact, and manual Cells. */
export interface TextCellInput extends BaseCellInput {
  readonly text: string;
}

/** Shared identity, provenance, and temporal fields accepted by every Cell builder. */
interface BaseCellInput {
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly threadId?: string;
  readonly sourceEntryIds: readonly string[];
  readonly timestampRange?: FormationCellTimestampRange;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Builds deterministic long-term-memory formation cells without replacing transcript truth. */
export class FormationCellBuilder {
  /** Deterministic id source used by tests and replayable ingestion jobs. */
  private readonly idFactory: (seed: string) => string;

  public constructor(options: FormationCellBuilderOptions = {}) {
    this.idFactory = options.idFactory ?? defaultCellId;
  }

  /** Creates a turn-level cell from user, assistant, and selected tool prose. */
  public fromTurn(input: TurnCellInput): FormationCell {
    if (input.text?.trim()) return this.create("turn", "turn", { ...input, text: input.text });
    const parts = [
      input.userText?.trim() ? `user: ${input.userText.trim()}` : "",
      input.assistantText?.trim() ? `assistant: ${input.assistantText.trim()}` : "",
      input.toolText?.trim() ? `tool: ${input.toolText.trim()}` : "",
    ].filter(Boolean);
    return this.create("turn", "turn", { ...input, text: parts.join("\n") });
  }

  /** Creates an episode cell, usually from a completed task or session summary. */
  public fromEpisode(input: TextCellInput): FormationCell {
    return this.create("episode", "session", input);
  }

  /** Creates a tool observation cell when tool output is independently useful. */
  public fromToolObservation(input: TextCellInput): FormationCell {
    return this.create("tool", "turn", input);
  }

  /** Creates a cell from a compact summary so episodic memories can cite compaction evidence. */
  public fromCompactSummary(input: TextCellInput): FormationCell {
    return this.create("compact-summary", "compact", input);
  }

  /** Creates a manual cell for explicit remember-style writes. */
  public fromManualMemory(input: TextCellInput): FormationCell {
    return this.create("manual", "manual", input);
  }

  private create(cellType: FormationCellType, trigger: FormationTrigger, input: TextCellInput): FormationCell {
    const text = input.text.trim();
    if (!text) throw new Error("formation cell text must not be empty");
    if (input.sourceEntryIds.length === 0) throw new Error("formation cell requires at least one source entry id");
    const seed = JSON.stringify({
      cellType,
      trigger,
      projectId: input.projectId,
      sessionId: input.sessionId,
      threadId: input.threadId,
      sourceEntryIds: input.sourceEntryIds,
      text,
    });
    // Deduplicate source ids while keeping their original order so sourceRefs
    // remain compact and deterministic for Markdown, recall, and benchmarks.
    return {
      id: this.idFactory(seed),
      cellType,
      trigger,
      text,
      sourceEntryIds: [...new Set(input.sourceEntryIds)],
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.timestampRange === undefined ? {} : { timestampRange: input.timestampRange }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
  }
}

/** Converts a formation cell into the existing framework-neutral observation shape. */
export function formationCellToObservation(cell: FormationCell): MemoryObservation {
  return {
    text: cell.text,
    sourceRefs: cell.sourceEntryIds,
    ...(cell.projectId === undefined ? {} : { projectId: cell.projectId }),
    metadata: {
      ...cell.metadata,
      formationCellId: cell.id,
      formationCellType: cell.cellType,
      formationTrigger: cell.trigger,
      cellType: cell.cellType,
      trigger: cell.trigger,
      sourceEntryIds: cell.sourceEntryIds,
      ...(cell.sessionId === undefined ? {} : { sessionId: cell.sessionId }),
      ...(cell.threadId === undefined ? {} : { threadId: cell.threadId }),
      ...(cell.timestampRange === undefined ? {} : { timestampRange: cell.timestampRange }),
    },
  };
}

function defaultCellId(seed: string): string {
  // Stable hashes make repeated offline formation/evaluation runs comparable.
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 24);
  return digest ? `cell_${digest}` : `cell_${randomUUID()}`;
}
