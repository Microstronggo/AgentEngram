import { describe, expect, it } from "vitest";
import { normalizePiTranscriptEntry } from "./pi-transcript-normalizer.js";

describe("normalizePiTranscriptEntry", () => {
  it("maps pi user and assistant message entries", () => {
    const user = normalizePiTranscriptEntry({
      sessionId: "s1",
      threadId: "t1",
      entry: { id: "u1", type: "message", message: { id: "u1", role: "user", content: [{ type: "text", text: "hi" }] } },
    });
    expect(user.normalized).toMatchObject({ kind: "message", role: "user", text: "hi" });
    expect(user.raw.sourceRef).toBe("agentengram://transcript/s1/t1/u1");
  });

  it("maps pi tool result messages", () => {
    const result = normalizePiTranscriptEntry({
      sessionId: "s1",
      threadId: "t1",
      entry: { id: "tr1", type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "Read", content: "ok" } },
    });
    expect(result.normalized).toMatchObject({ kind: "tool_result", role: "toolResult", toolCallId: "call-1", toolName: "Read", text: "ok" });
    expect(result.raw.eventType).toBe("tool.completed");
  });

  it("maps pi compaction entries", () => {
    const result = normalizePiTranscriptEntry({
      sessionId: "s1",
      threadId: "t1",
      entry: { id: "c1", type: "compaction", summary: "old summary", firstKeptEntryId: "u2", tokensBefore: 123 },
    });
    expect(result.normalized).toMatchObject({ kind: "compaction", text: "old summary" });
    expect(result.raw.eventType).toBe("compact.completed");
  });

  it("maps pi branch and custom entries", () => {
    const branch = normalizePiTranscriptEntry({
      sessionId: "s1",
      threadId: "t1",
      entry: { id: "b1", type: "branch_summary", summary: "branch" },
    });
    const custom = normalizePiTranscriptEntry({
      sessionId: "s1",
      threadId: "t1",
      entry: { id: "x1", type: "custom", customType: "agentengram.checkpoint.v1", data: { ok: true } },
    });
    expect(branch.normalized.kind).toBe("branch_summary");
    expect(custom.normalized.kind).toBe("custom");
  });

  it("preserves pi entry id, parent id, leaf id and source refs", () => {
    const result = normalizePiTranscriptEntry({
      sessionId: "s1",
      threadId: "t1",
      entry: { id: "e1", parentId: "p1", leafId: "l1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    });
    expect(result.raw).toMatchObject({
      frameworkEntryId: "e1",
      parentEntryId: "p1",
      frameworkSourceRef: "pi://session/s1/thread/t1/entry/e1",
    });
    expect(result.normalized.sourceRef).toBe("agentengram://transcript/s1/t1/e1");
  });
});

