import { describe, expect, it } from "vitest";
import type { NormalizedTranscriptEntry } from "../../../transcript/normalized-transcript-entry.js";
import { transcriptEntriesToBoundaryEntries, transcriptEntryToBoundaryEntry } from "./transcript-boundary-entry.js";

describe("transcriptEntryToBoundaryEntry", () => {
  it("keeps chat visible and tool evidence hidden with provenance", () => {
    const user = entry({ id: "u1", kind: "message", role: "user", text: "Discuss managed context." });
    const tool = entry({ id: "t1", kind: "tool_result", role: "tool", text: "large result", toolName: "exec" });

    expect(transcriptEntryToBoundaryEntry(user)).toMatchObject({
      id: "u1",
      role: "user",
      text: "Discuss managed context.",
      sourceRef: "agentengram://transcript/s1/t1/u1",
    });
    expect(transcriptEntryToBoundaryEntry(tool)).toMatchObject({
      id: "t1",
      role: "tool",
      text: "large result",
      boundaryText: "[tool result: exec]",
      includeInBoundaryPrompt: false,
    });
  });

  it("maps summaries and drops lifecycle/custom entries", () => {
    const entries = transcriptEntriesToBoundaryEntries([
      entry({ id: "c1", kind: "compaction", text: "Previous task summary." }),
      entry({ id: "l1", kind: "lifecycle", text: "turn ended" }),
      entry({ id: "x1", kind: "custom", text: "private extension state" }),
    ]);
    expect(entries).toMatchObject([{ id: "c1", role: "summary", text: "Previous task summary." }]);
  });
});

function entry(overrides: Partial<NormalizedTranscriptEntry> & Pick<NormalizedTranscriptEntry, "id" | "kind">): NormalizedTranscriptEntry {
  return {
    schemaVersion: 1,
    sessionId: "s1",
    threadId: "t1",
    sourceRef: `agentengram://transcript/s1/t1/${overrides.id}`,
    contentHash: `hash-${overrides.id}`,
    createdAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}
