import { describe, expect, it } from "vitest";
import { createFrameworkSourceRef, createTranscriptSourceRef } from "./source-ref.js";

describe("transcript source refs", () => {
  it("creates stable AgentEngram source refs", () => {
    expect(createTranscriptSourceRef({ sessionId: "s1", threadId: "t1", entryId: "e1" }))
      .toBe("agentengram://transcript/s1/t1/e1");
  });

  it("creates stable framework source refs", () => {
    expect(createFrameworkSourceRef({ framework: "pi", sessionId: "s1", threadId: "t1", entryId: "e1" }))
      .toBe("pi://session/s1/thread/t1/entry/e1");
  });

  it("rejects unsafe ids", () => {
    expect(() => createTranscriptSourceRef({ sessionId: "../secret", threadId: "t1", entryId: "e1" }))
      .toThrow("unsafe sessionId");
  });
});

