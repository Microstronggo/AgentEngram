import type {
  HostBinding,
  SourceCheckpointRepository,
  TranscriptAppendInput,
} from "@agentengram/engine/adapter";
import {
  normalizePiBranchTranscript,
  piTranscriptEntryId,
} from "./pi-transcript-normalizer.js";

export interface PiBranchIngestionInput {
  readonly sourceId: string;
  readonly sourceVersion?: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly branchEntries: readonly unknown[];
  readonly hostBinding?: HostBinding;
  readonly checkpoints: SourceCheckpointRepository;
  /** Transcript persistence boundary; the checkpoint advances only after it succeeds. */
  readonly append: (entries: readonly TranscriptAppendInput[]) => Promise<void>;
  readonly now?: () => Date;
}

export interface PiBranchIngestionResult {
  readonly appendedEntries: number;
  readonly reconciled: boolean;
  readonly cursor?: string;
}

/**
 * Persists only the suffix after the last durable Pi entry. If Pi compacted or
 * replaced the branch and the cursor disappeared, the complete active branch
 * is replayed through TranscriptStore's idempotent append path.
 */
export async function ingestPiBranchIncrementally(
  input: PiBranchIngestionInput,
): Promise<PiBranchIngestionResult> {
  if (input.branchEntries.length === 0) return { appendedEntries: 0, reconciled: false };
  const checkpoint = await input.checkpoints.load(input.sourceId);
  // A different backing session file invalidates an otherwise matching entry
  // cursor. Replaying the active branch is safe because TranscriptStore append
  // is idempotent, while trusting a recycled id could skip new evidence.
  const sourceChanged = checkpoint?.sourceVersion !== undefined
    && input.sourceVersion !== undefined
    && checkpoint.sourceVersion !== input.sourceVersion;
  const cursorIndex = checkpoint === undefined || sourceChanged
    ? -1
    : input.branchEntries.findIndex((entry, index) =>
        piTranscriptEntryId(entry, index) === checkpoint.cursorValue);
  const reconciled = checkpoint !== undefined && (sourceChanged || cursorIndex < 0);
  const startIndex = checkpoint === undefined || cursorIndex < 0 ? 0 : cursorIndex + 1;
  const suffix = input.branchEntries.slice(startIndex);
  const normalized = normalizePiBranchTranscript({
    sessionId: input.sessionId,
    threadId: input.threadId,
    branchEntries: suffix,
    startIndex,
    ...(input.hostBinding === undefined ? {} : { hostBinding: input.hostBinding }),
  });

  // This ordering is the ingestion transaction contract: a failed append must
  // leave the old waterline untouched so evidence is retried on the next hook.
  if (normalized.length > 0) {
    await input.append(normalized.map(({ raw, normalized: entry }) => ({ raw, normalized: entry })));
  }
  const lastIndex = input.branchEntries.length - 1;
  const last = input.branchEntries[lastIndex]!;
  const cursor = piTranscriptEntryId(last, lastIndex);
  await input.checkpoints.save({
    schemaVersion: 1,
    sourceId: input.sourceId,
    ...(input.sourceVersion === undefined ? {} : { sourceVersion: input.sourceVersion }),
    cursorType: "entry-id",
    cursorValue: cursor,
    parserState: {
      entryCount: input.branchEntries.length,
      ...(input.hostBinding === undefined ? {} : {
        namespaceId: input.hostBinding.namespaceId,
        hostType: input.hostBinding.identity.hostType,
      }),
    },
    updatedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  return { appendedEntries: normalized.length, reconciled, cursor };
}
