import type { NormalizedTranscriptEntry } from "../../../transcript/normalized-transcript-entry.js";
import type { BoundaryEntry, BoundaryMessageRole } from "./cell-boundary.js";

/** Converts portable transcript truth into the reduced view used for Cell boundaries. */
export function transcriptEntryToBoundaryEntry(entry: NormalizedTranscriptEntry): BoundaryEntry | undefined {
  if (entry.kind === "lifecycle" || entry.kind === "custom") return undefined;
  const role = boundaryRole(entry);
  if (!role) return undefined;
  const text = durableBoundaryText(entry);
  if (!text) return undefined;
  const hiddenToolEvidence = entry.kind === "tool_call" || entry.kind === "tool_result";
  return {
    id: entry.id,
    role,
    text,
    sourceRef: entry.sourceRef,
    timestamp: entry.createdAt,
    ...(hiddenToolEvidence
      ? {
          includeInBoundaryPrompt: false,
          boundaryText: toolSummary(entry),
        }
      : {}),
  };
}

/** Maps an ordered thread transcript while dropping entries irrelevant to memory boundaries. */
export function transcriptEntriesToBoundaryEntries(
  entries: readonly NormalizedTranscriptEntry[],
): readonly BoundaryEntry[] {
  return entries.flatMap((entry) => {
    const mapped = transcriptEntryToBoundaryEntry(entry);
    return mapped ? [mapped] : [];
  });
}

function boundaryRole(entry: NormalizedTranscriptEntry): BoundaryMessageRole | undefined {
  if (entry.kind === "tool_call" || entry.kind === "tool_result") return "tool";
  if (entry.kind === "compaction" || entry.kind === "branch_summary") return "summary";
  if (entry.role === "user" || entry.role === "assistant" || entry.role === "system") return entry.role;
  return undefined;
}

function durableBoundaryText(entry: NormalizedTranscriptEntry): string | undefined {
  const text = entry.text?.trim();
  if (text) return text;
  if (entry.kind === "tool_call") return `[tool call${entry.toolName ? `: ${entry.toolName}` : ""}]`;
  if (entry.kind === "tool_result") {
    return `[tool result${entry.toolName ? `: ${entry.toolName}` : ""}${entry.isError ? "; error" : ""}]`;
  }
  return undefined;
}

function toolSummary(entry: NormalizedTranscriptEntry): string {
  const label = entry.kind === "tool_call" ? "tool call" : "tool result";
  return `[${label}${entry.toolName ? `: ${entry.toolName}` : ""}${entry.isError ? "; error" : ""}]`;
}
