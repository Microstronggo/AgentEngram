import { describe, expect, it } from "vitest";
import { canonicalBranchMessages } from "./canonical-branch.js";

const time = "2026-06-22T00:00:00.000Z";

describe("Pi canonical branch contract", () => {
  it("mirrors Pi message, custom-message, and branch-summary projection", () => {
    const user = { role: "user", content: "hello", timestamp: 1 };
    expect(canonicalBranchMessages([
      { type: "message", id: "m1", timestamp: time, message: user },
      { type: "custom", id: "state", timestamp: time, customType: "state", data: { ignored: true } },
      {
        type: "custom_message",
        id: "cm1",
        timestamp: time,
        customType: "memory",
        content: "remember this",
        display: false,
        details: { source: "test" },
      },
      { type: "branch_summary", id: "b1", timestamp: time, summary: "old branch", fromId: "old-leaf" },
    ])).toEqual([
      user,
      {
        role: "custom",
        customType: "memory",
        content: "remember this",
        display: false,
        details: { source: "test" },
        timestamp: new Date(time).getTime(),
      },
      { role: "branchSummary", summary: "old branch", fromId: "old-leaf", timestamp: new Date(time).getTime() },
    ]);
  });

  it("uses the latest compaction and preserves only its kept prefix plus later messages", () => {
    const before = { role: "user", content: "collapsed" };
    const kept = { role: "assistant", content: "kept" };
    const after = { role: "user", content: "after" };
    expect(canonicalBranchMessages([
      { type: "message", id: "m0", timestamp: time, message: before },
      { type: "message", id: "m1", timestamp: time, message: kept },
      {
        type: "compaction",
        id: "c1",
        timestamp: time,
        summary: "summary",
        firstKeptEntryId: "m1",
        tokensBefore: 123,
      },
      { type: "message", id: "m2", timestamp: time, message: after },
    ])).toEqual([
      { role: "compactionSummary", summary: "summary", tokensBefore: 123, timestamp: new Date(time).getTime() },
      kept,
      after,
    ]);
  });
});
