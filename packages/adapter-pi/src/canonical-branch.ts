interface PiBranchEntry {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: unknown;
  customType?: unknown;
  content?: unknown;
  display?: unknown;
  details?: unknown;
  summary?: unknown;
  fromId?: unknown;
  firstKeptEntryId?: unknown;
  tokensBefore?: unknown;
}

/**
 * Rebuild Pi's active LLM transcript from getBranch().
 *
 * This intentionally mirrors pi-mono's buildSessionContext semantics: the latest
 * compaction replaces its collapsed prefix, custom messages and branch summaries
 * participate in context, while bookkeeping/custom entries do not.
 */
export function canonicalBranchMessages(branch: readonly unknown[] | undefined): unknown[] {
  if (!branch) return [];
  const entries = branch.filter(isEntry);
  let compaction: PiBranchEntry | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.type === "compaction") {
      compaction = entries[index];
      break;
    }
  }
  if (!compaction) return entries.flatMap(entryMessages);

  const compactionIndex = entries.indexOf(compaction);
  const firstKeptEntryId = typeof compaction.firstKeptEntryId === "string"
    ? compaction.firstKeptEntryId
    : undefined;
  const messages: unknown[] = [compactionMessage(compaction)];
  let foundFirstKept = false;
  for (let index = 0; index < compactionIndex; index += 1) {
    const entry = entries[index]!;
    if (entry.id === firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) messages.push(...entryMessages(entry));
  }
  for (let index = compactionIndex + 1; index < entries.length; index += 1) {
    messages.push(...entryMessages(entries[index]!));
  }
  return messages;
}

function isEntry(value: unknown): value is PiBranchEntry {
  return value !== null && typeof value === "object";
}

function entryMessages(entry: PiBranchEntry): unknown[] {
  if (entry.type === "message" && "message" in entry) return [entry.message];
  if (entry.type === "custom_message" && typeof entry.customType === "string") {
    return [{
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display === true,
      details: entry.details,
      timestamp: timestamp(entry.timestamp),
    }];
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string" && entry.summary !== "") {
    return [{
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      timestamp: timestamp(entry.timestamp),
    }];
  }
  return [];
}

function compactionMessage(entry: PiBranchEntry): unknown {
  return {
    role: "compactionSummary",
    summary: typeof entry.summary === "string" ? entry.summary : "",
    tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0,
    timestamp: timestamp(entry.timestamp),
  };
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  return new Date(value).getTime();
}
