import { FormationCellBuilder, type FormationCell, type FormationCellTimestampRange } from "./formation-cell.js";

/** Reduced roles used only for Cell boundary decisions. */
export type BoundaryMessageRole = "system" | "user" | "assistant" | "tool" | "summary";

/** Reduced transcript evidence used to detect coherent Cell boundaries. */
export interface BoundaryEntry {
  /** Stable source id from the canonical transcript, compact summary, or tool event. */
  readonly id: string;
  /** Coarse role used to render the boundary-detection view. */
  readonly role: BoundaryMessageRole;
  /** Original message text or a short tool/result summary. */
  readonly text: string;
  /** Optional canonical source ref stored on the resulting FormationCell. */
  readonly sourceRef?: string;
  /** Optional shorter text shown to the boundary model instead of full evidence text. */
  readonly boundaryText?: string;
  /** ISO timestamp used for date-change boundaries and episode metadata. */
  readonly timestamp?: string;
  /** When false, this entry is preserved as evidence but hidden from the LLM boundary prompt. */
  readonly includeInBoundaryPrompt?: boolean;
}

/** Backward-compatible alias for the boundary-entry contract. */
export type BoundaryMessage = BoundaryEntry;

/** New evidence, persisted tail, and deterministic limits for one boundary pass. */
export interface BoundaryDetectionInput {
  /** Per-thread task cancellation propagated into model-backed detectors. */
  readonly signal?: AbortSignal;
  readonly entries?: readonly BoundaryEntry[];
  readonly messages?: readonly BoundaryEntry[];
  readonly priorTail?: readonly BoundaryEntry[];
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly threadId?: string;
  /** Flushes the final ambiguous tail into a closed cell. */
  readonly isFinal?: boolean;
  /** Deterministic guardrail for very long cells, independent of provider behavior. */
  readonly maxMessagesPerCell?: number;
  /** Backward-compatible alias for maxMessagesPerCell. */
  readonly maxEntriesPerCell?: number;
  /** Approximate character guardrail used when a tokenizer is unavailable. */
  readonly maxCharactersPerCell?: number;
}

/** Closed Cells plus the ambiguous tail retained for the next pass. */
export interface BoundaryDetectionResult {
  /** Closed cells ready for staged long-term-memory formation. */
  readonly cells: readonly FormationCell[];
  /** Ambiguous messages that should be kept in the online tail buffer. */
  readonly tail: readonly BoundaryEntry[];
  /** Deterministic or provider-proposed ids that closed cells. */
  readonly boundaryAfterEntryIds?: readonly string[];
}

/** Injectable boundary strategy used by production LLM and deterministic tests. */
export interface CellBoundaryDetectorLike {
  detect(input: BoundaryDetectionInput): Promise<BoundaryDetectionResult>;
}

/** Model-proposed split positions over the numbered visible-entry view. */
export interface BoundaryDecision {
  /** 1-based message numbers after which the detector wants to split. */
  readonly boundaries: readonly number[];
  /** True when the trailing segment is too ambiguous to close. */
  readonly shouldWait: boolean;
  readonly reasoning?: string;
}

/** Model boundary that returns numbered splits over a sanitized visible view. */
export interface BoundaryDecisionModel {
  decide(input: BoundaryDetectionInput, renderedEntries: string): Promise<BoundaryDecision>;
}

/** Model and deterministic hard limits for LLM-backed boundary detection. */
export interface CellBoundaryDetectorOptions {
  readonly model: BoundaryDecisionModel;
  readonly idFactory?: (seed: string) => string;
  readonly hardMessageLimit?: number;
  readonly hardTokenLimit?: number;
  readonly estimateTokens?: (text: string) => number;
}

/** LLM-backed boundary detector with deterministic hard-limit and final-tail handling. */
export class CellBoundaryDetector implements CellBoundaryDetectorLike {
  private readonly cellBuilder: FormationCellBuilder;
  private readonly estimateTokens: (text: string) => number;

  public constructor(private readonly options: CellBoundaryDetectorOptions) {
    this.cellBuilder = new FormationCellBuilder(options.idFactory ? { idFactory: options.idFactory } : {});
    this.estimateTokens = options.estimateTokens ?? approximateTokens;
  }

  public async detect(input: BoundaryDetectionInput): Promise<BoundaryDetectionResult> {
    // The previous ambiguous tail and the new batch must be judged together.
    // Otherwise the model cannot see that a new message completes the prior
    // topic, and buildBoundaryCells would also risk duplicating priorTail.
    const entries = [...(input.priorTail ?? []), ...getInputEntries(input)];
    if (entries.length === 0) return { cells: [], tail: [], boundaryAfterEntryIds: [] };
    const hardMessageLimit = Math.max(2, input.maxMessagesPerCell ?? input.maxEntriesPerCell ?? this.options.hardMessageLimit ?? 50);
    const hardTokenLimit = Math.max(1, this.options.hardTokenLimit ?? 8_192);
    const forcedCells: FormationCell[] = [];
    let remaining = entries;

    // Close full-size prefixes before asking the LLM. The model should judge
    // only the bounded tail, while deterministic hard limits guarantee that a
    // repeatedly ambiguous topic cannot grow without bound.
    while (remaining.length > hardMessageLimit) {
      forcedCells.push(toCell(remaining.slice(0, hardMessageLimit), input, this.cellBuilder));
      remaining = remaining.slice(hardMessageLimit);
    }

    const measure = input.maxCharactersPerCell === undefined
      ? (segment: readonly BoundaryEntry[]) => this.estimateTokens(renderCellText(segment))
      : characterCount;
    const contentLimit = input.maxCharactersPerCell ?? hardTokenLimit;
    while (measure(remaining) > contentLimit && remaining.length > 1) {
      const splitAt = prefixWithinLimit(remaining, measure, contentLimit);
      forcedCells.push(toCell(remaining.slice(0, splitAt), input, this.cellBuilder));
      remaining = remaining.slice(splitAt);
    }

    // Let the model judge boundaries over a clean user-visible view. Hidden and
    // tool entries remain in the full evidence stream and are folded back into
    // cells by remapBoundaryIds().
    const visibleEntries = remaining.filter((entry) => entry.includeInBoundaryPrompt !== false);
    if (visibleEntries.length === 0) {
      return input.isFinal
        ? { cells: [...forcedCells, toCell(remaining, input, this.cellBuilder)], tail: [], boundaryAfterEntryIds: [] }
        : { cells: forcedCells, tail: remaining, boundaryAfterEntryIds: [] };
    }
    const decisionInput = boundaryInputWithEntries(input, remaining);
    const decision = await this.options.model.decide(decisionInput, renderBoundaryMessages(visibleEntries));
    const boundaryAfterEntryIds = boundaryNumbersToIds(decision.boundaries, visibleEntries);
    const detectionInput = boundaryInputWithEntries(input, remaining, input.isFinal && !decision.shouldWait);
    const detected = buildBoundaryCells({
      input: detectionInput,
      boundaryAfterEntryIds,
      cellBuilder: this.cellBuilder,
      maxMessagesPerCell: hardMessageLimit,
      // Token limits were already enforced above with the configured
      // estimator. Disable buildBoundaryCells' unrelated character default
      // unless the caller explicitly requested a character limit.
      maxCharactersPerCell: input.maxCharactersPerCell ?? Number.MAX_SAFE_INTEGER,
    });
    if (input.isFinal && detected.tail.length > 0) {
      return { cells: [...forcedCells, ...detected.cells, toCell(detected.tail, input, this.cellBuilder)], tail: [], boundaryAfterEntryIds };
    }
    return { ...detected, cells: [...forcedCells, ...detected.cells], boundaryAfterEntryIds };
  }
}

/** Date, message-count, and character limits for the no-model fallback. */
export interface DeterministicCellBoundaryDetectorOptions {
  readonly cellBuilder?: FormationCellBuilder;
  readonly maxMessagesPerCell?: number;
  readonly maxCharactersPerCell?: number;
}

/** Deterministic fallback that closes cells on date changes, final flush, and hard limits. */
export class DeterministicCellBoundaryDetector implements CellBoundaryDetectorLike {
  private readonly cellBuilder: FormationCellBuilder;
  private readonly maxMessagesPerCell: number;
  private readonly maxCharactersPerCell: number;

  public constructor(options: DeterministicCellBoundaryDetectorOptions = {}) {
    this.cellBuilder = options.cellBuilder ?? new FormationCellBuilder();
    this.maxMessagesPerCell = options.maxMessagesPerCell ?? 12;
    this.maxCharactersPerCell = options.maxCharactersPerCell ?? 12_000;
  }

  public async detect(input: BoundaryDetectionInput): Promise<BoundaryDetectionResult> {
    const maxMessagesPerCell = input.maxMessagesPerCell ?? input.maxEntriesPerCell ?? this.maxMessagesPerCell;
    const maxCharactersPerCell = input.maxCharactersPerCell ?? this.maxCharactersPerCell;
    return buildBoundaryCells({
      input,
      boundaryAfterEntryIds: deterministicBoundaryIds(input, { maxMessagesPerCell, maxCharactersPerCell }),
      cellBuilder: this.cellBuilder,
      maxMessagesPerCell,
      maxCharactersPerCell,
    });
  }
}

/** Compatibility name for the deterministic boundary fallback used by existing tests. */
export class HeuristicCellBoundaryDetector extends DeterministicCellBoundaryDetector {
  public constructor(idFactory?: (seed: string) => string) {
    super(idFactory ? { cellBuilder: new FormationCellBuilder({ idFactory }) } : {});
  }
}

/** Full evidence plus proposed visible-entry boundaries for Cell construction. */
export interface BuildBoundaryCellsInput {
  readonly input: BoundaryDetectionInput;
  readonly boundaryAfterEntryIds: readonly string[];
  readonly cellBuilder?: FormationCellBuilder;
  readonly idFactory?: (seed: string) => string;
  readonly maxMessagesPerCell?: number;
  readonly maxCharactersPerCell?: number;
}

/** Converts provider boundary ids back into full evidence-preserving FormationCells. */
export function buildBoundaryCells(options: BuildBoundaryCellsInput): BoundaryDetectionResult {
  const cellBuilder = options.cellBuilder ?? new FormationCellBuilder(options.idFactory ? { idFactory: options.idFactory } : {});
  const entries = [...(options.input.priorTail ?? []), ...getInputEntries(options.input)].filter((entry) => entry.text.trim());
  // Boundary ids may refer to visible chat entries only. Remapping expands a
  // boundary across immediately following hidden/tool evidence so the resulting
  // FormationCell keeps the full factual provenance needed by later extraction.
  const boundaryIds = new Set(remapBoundaryIds(entries, options.boundaryAfterEntryIds));
  const segments: BoundaryEntry[][] = [];
  let current: BoundaryEntry[] = [];
  let currentCharacters = 0;

  for (const entry of entries) {
    const previous = current.at(-1);
    const dateChanged = Boolean(previous?.timestamp && entry.timestamp && isoDate(previous.timestamp) !== isoDate(entry.timestamp));
    const hardLimitReached = current.length >= (options.maxMessagesPerCell ?? 12) ||
      currentCharacters + entry.text.length > (options.maxCharactersPerCell ?? 12_000);
    if (current.length > 0 && (dateChanged || hardLimitReached)) {
      segments.push(current);
      current = [];
      currentCharacters = 0;
    }
    current.push(entry);
    currentCharacters += entry.text.length;
    if (boundaryIds.has(entry.id)) {
      segments.push(current);
      current = [];
      currentCharacters = 0;
    }
  }

  const cells = segments.map((segment) => toCell(segment, options.input, cellBuilder));
  const boundaryAfterEntryIds = [...boundaryIds];
  if (options.input.isFinal && current.length > 0) {
    return { cells: [...cells, toCell(current, options.input, cellBuilder)], tail: [], boundaryAfterEntryIds };
  }
  return { cells, tail: current, boundaryAfterEntryIds };
}

/** Compatibility helper that applies deterministic hard boundaries to messages. */
export function splitMessages(
  messages: readonly BoundaryEntry[],
  options: { readonly maxMessagesPerCell: number; readonly maxCharactersPerCell: number },
): readonly (readonly BoundaryEntry[])[] {
  return buildBoundaryCells({
    input: { entries: messages, isFinal: true },
    boundaryAfterEntryIds: deterministicBoundaryIds({ entries: messages, isFinal: true }, options),
    ...options,
  }).cells.map((cell) => messages.filter((message) => cell.sourceEntryIds.includes(message.id)));
}

/** Renders complete Cell evidence, including tool entries hidden from boundary prompts. */
export function renderCellText(entries: readonly BoundaryEntry[]): string {
  return entries
    .map((entry) => `${entry.role}: ${entry.text.trim()}`)
    .join("\n")
    .trim();
}

function deterministicBoundaryIds(
  input: BoundaryDetectionInput,
  options: { readonly maxMessagesPerCell: number; readonly maxCharactersPerCell: number },
): readonly string[] {
  const entries = [...(input.priorTail ?? []), ...getInputEntries(input)].filter((entry) => entry.text.trim());
  const ids: string[] = [];
  let current: BoundaryEntry[] = [];
  let currentCharacters = 0;
  for (const entry of entries) {
    const previous = current.at(-1);
    const dateChanged = Boolean(previous?.timestamp && entry.timestamp && isoDate(previous.timestamp) !== isoDate(entry.timestamp));
    const hardLimitReached = current.length >= options.maxMessagesPerCell || currentCharacters + entry.text.length > options.maxCharactersPerCell;
    if (current.length > 0 && (dateChanged || hardLimitReached)) ids.push(current[current.length - 1]!.id);
    if (dateChanged || hardLimitReached) {
      current = [];
      currentCharacters = 0;
    }
    current.push(entry);
    currentCharacters += entry.text.length;
  }
  return ids;
}

function remapBoundaryIds(entries: readonly BoundaryEntry[], boundaryAfterEntryIds: readonly string[]): readonly string[] {
  const ids = new Set(entries.map((entry) => entry.id));
  const remapped: string[] = [];
  for (const boundaryId of boundaryAfterEntryIds) {
    if (!ids.has(boundaryId)) continue;
    const index = entries.findIndex((entry) => entry.id === boundaryId);
    let end = index;
    // Providers often hide tool output from the boundary prompt. If the model
    // closes after the last visible chat entry, carry immediately following
    // hidden/tool evidence into the same cell before the next visible entry.
    for (let cursor = index + 1; cursor < entries.length; cursor++) {
      const next = entries[cursor]!;
      if (next.role !== "tool" && next.includeInBoundaryPrompt !== false) break;
      end = cursor;
    }
    remapped.push(entries[end]!.id);
  }
  return remapped;
}

function toCell(segment: readonly BoundaryEntry[], input: BoundaryDetectionInput, cellBuilder: FormationCellBuilder): FormationCell {
  const timestampRange = timestampRangeFor(segment);
  // Cell text intentionally includes tool evidence after boundary remapping.
  // Extraction needs the evidence; only boundary detection receives the reduced
  // view to avoid noisy JSON/tool payloads driving topic cuts.
  return cellBuilder.fromEpisode({
    text: renderCellText(segment),
    sourceEntryIds: segment.map((entry) => entry.sourceRef ?? entry.id),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    ...(timestampRange === undefined ? {} : { timestampRange }),
    metadata: { boundaryDetector: "cell-boundary" },
  });
}

function timestampRangeFor(entries: readonly BoundaryEntry[]): FormationCellTimestampRange | undefined {
  const timestamps = entries.flatMap((entry) => entry.timestamp ? [entry.timestamp] : []);
  if (timestamps.length === 0) return undefined;
  return { start: timestamps[0]!, end: timestamps[timestamps.length - 1]! };
}

function isoDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** Renders the numbered, sanitized view shown to a boundary model. */
export function renderBoundaryMessages(entries: readonly BoundaryEntry[]): string {
  return entries
    .filter((entry) => entry.includeInBoundaryPrompt !== false)
    .map((entry, index) => `[${index + 1}] ${renderBoundaryLine(entry)}`)
    .join("\n");
}

function renderBoundaryLine(entry: BoundaryEntry): string {
  const time = entry.timestamp ? `[${entry.timestamp}] ` : "";
  return `${time}${entry.role}: ${(entry.boundaryText ?? entry.text).trim()}`;
}

function boundaryNumbersToIds(boundaries: readonly number[], entries: readonly BoundaryEntry[]): readonly string[] {
  return [...new Set(boundaries
    .map((boundary) => Math.floor(boundary))
    .filter((boundary) => boundary > 0 && boundary <= entries.length)
    .map((boundary) => entries[boundary - 1]?.id)
    .filter((id): id is string => Boolean(id)))]
    .sort((left, right) => entries.findIndex((entry) => entry.id === left) - entries.findIndex((entry) => entry.id === right));
}

function getInputEntries(input: BoundaryDetectionInput): readonly BoundaryEntry[] {
  return input.entries ?? input.messages ?? [];
}

function characterCount(entries: readonly BoundaryEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.text.length, 0);
}

function prefixWithinLimit(
  entries: readonly BoundaryEntry[],
  measure: (entries: readonly BoundaryEntry[]) => number,
  limit: number,
): number {
  // A single oversized entry cannot be split without corrupting transcript
  // provenance, so it becomes its own forced Cell.
  let splitAt = 1;
  while (splitAt < entries.length && measure(entries.slice(0, splitAt + 1)) <= limit) splitAt++;
  return splitAt;
}

function approximateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function boundaryInputWithEntries(input: BoundaryDetectionInput, entries: readonly BoundaryEntry[], isFinal?: boolean): BoundaryDetectionInput {
  const {
    entries: _entries,
    messages: _messages,
    priorTail: _priorTail,
    isFinal: _isFinal,
    ...rest
  } = input;
  return {
    ...rest,
    entries,
    ...(isFinal === undefined ? {} : { isFinal }),
  };
}
