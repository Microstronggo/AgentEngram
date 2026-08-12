import { describe, expect, it } from "vitest";
import { buildBoundaryCells, CellBoundaryDetector, HeuristicCellBoundaryDetector } from "./cell-boundary.js";
import { FormationCellBuilder, formationCellToObservation } from "./formation-cell.js";

describe("FormationCellBuilder", () => {
  const builder = new FormationCellBuilder({ idFactory: (seed) => `cell-${seed.length}` });

  it("creates turn cells and preserves provenance in observations", () => {
    const cell = builder.fromTurn({
      projectId: "project-a",
      sessionId: "session-a",
      threadId: "thread-a",
      sourceEntryIds: ["entry-u1", "entry-a1"],
      userText: "Use pnpm.",
      assistantText: "Acknowledged.",
      timestampRange: { start: "2026-06-25T00:00:00.000Z", end: "2026-06-25T00:01:00.000Z" },
      metadata: { adapter: "pi-mono" },
    });

    expect(cell).toMatchObject({ cellType: "turn", trigger: "turn", projectId: "project-a" });
    expect(cell.text).toContain("user: Use pnpm.");
    expect(cell.text).toContain("assistant: Acknowledged.");
    expect(formationCellToObservation(cell)).toMatchObject({
      text: cell.text,
      sourceRefs: ["entry-u1", "entry-a1"],
      projectId: "project-a",
      metadata: {
        adapter: "pi-mono",
        formationCellId: cell.id,
        formationCellType: "turn",
        formationTrigger: "turn",
        sessionId: "session-a",
        threadId: "thread-a",
      },
    });
  });

  it("creates episode, tool, compact-summary and manual cells", () => {
    expect(builder.fromEpisode({ text: "Task completed.", sourceEntryIds: ["e1"] }).cellType).toBe("episode");
    expect(builder.fromToolObservation({ text: "Tool returned FTS rows.", sourceEntryIds: ["t1"] }).cellType).toBe("tool");
    expect(builder.fromCompactSummary({ text: "Compacted history.", sourceEntryIds: ["c1"] }).trigger).toBe("compact");
    expect(builder.fromManualMemory({ text: "Remember managed-context.", sourceEntryIds: ["m1"] }).trigger).toBe("manual");
  });

  it("rejects empty text and cells without sources", () => {
    expect(() => builder.fromManualMemory({ text: " ", sourceEntryIds: ["m1"] })).toThrow("text");
    expect(() => builder.fromManualMemory({ text: "Remember this.", sourceEntryIds: [] })).toThrow("source");
  });
});

describe("Cell boundary detection", () => {
  const entries = [
    { id: "u1", role: "user" as const, text: "Let's validate managed-context.", timestamp: "2026-06-25T09:00:00.000Z" },
    { id: "a1", role: "assistant" as const, text: "The validation passed.", timestamp: "2026-06-25T09:01:00.000Z" },
    { id: "t1", role: "tool" as const, text: "Large tool evidence", includeInBoundaryPrompt: false, timestamp: "2026-06-25T09:02:00.000Z" },
    { id: "u2", role: "user" as const, text: "Now discuss LoCoMo.", timestamp: "2026-06-26T09:00:00.000Z" },
  ];

  it("remaps visible boundary decisions back to hidden tool evidence", () => {
    const result = buildBoundaryCells({
      input: { entries, projectId: "agentengram", isFinal: false },
      boundaryAfterEntryIds: ["a1"],
      idFactory: () => "cell-boundary",
    });

    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]?.sourceEntryIds).toEqual(["u1", "a1", "t1"]);
    expect(result.cells[0]?.text).toContain("tool: Large tool evidence");
    expect(result.tail.map((entry) => entry.id)).toEqual(["u2"]);
  });

  it("keeps ambiguous tails open and flushes them when final", async () => {
    const detector = new HeuristicCellBoundaryDetector(() => "cell-final");
    await expect(detector.detect({ entries: entries.slice(0, 2), isFinal: false })).resolves.toMatchObject({
      cells: [],
      tail: entries.slice(0, 2),
    });

    const flushed = await detector.detect({ entries: entries.slice(0, 2), isFinal: true });
    expect(flushed.cells).toHaveLength(1);
    expect(flushed.tail).toEqual([]);
  });

  it("judges the prior ambiguous tail together with the next batch", async () => {
    let rendered = "";
    const detector = new CellBoundaryDetector({
      model: {
        decide: async (_input, renderedEntries) => {
          rendered = renderedEntries;
          return { boundaries: [2], shouldWait: true };
        },
      },
      idFactory: () => "cell-prior-tail",
    });
    const result = await detector.detect({
      priorTail: [{ id: "u0", role: "user", text: "Start managed-context validation." }],
      entries: [
        { id: "a0", role: "assistant", text: "The validation passed." },
        { id: "u1", role: "user", text: "Now discuss LoCoMo." },
      ],
    });

    expect(rendered).toContain("Start managed-context validation.");
    expect(result.cells[0]?.sourceEntryIds).toEqual(["u0", "a0"]);
    expect(result.tail.map((entry) => entry.id)).toEqual(["u1"]);
  });

  it("forces configured LLM detector hard limits before judging the bounded tail", async () => {
    let rendered = "";
    const detector = new CellBoundaryDetector({
      hardMessageLimit: 3,
      model: {
        decide: async (_input, renderedEntries) => {
          rendered = renderedEntries;
          return { boundaries: [], shouldWait: true };
        },
      },
      idFactory: () => "cell-hard-limit",
    });
    const result = await detector.detect({
      entries: [
        { id: "u1", role: "user", text: "one" },
        { id: "a1", role: "assistant", text: "two" },
        { id: "u2", role: "user", text: "three" },
        { id: "a2", role: "assistant", text: "four" },
      ],
    });

    expect(result.cells[0]?.sourceEntryIds).toEqual(["u1", "a1", "u2"]);
    expect(result.tail.map((entry) => entry.id)).toEqual(["a2"]);
    expect(rendered).toContain("four");
    expect(rendered).not.toContain("one");
  });

  it("forces deterministic boundaries on cross-day and hard message limits", async () => {
    const detector = new HeuristicCellBoundaryDetector((seed) => `cell-${seed.length}`);
    const result = await detector.detect({ entries, maxEntriesPerCell: 3 });
    expect(result.boundaryAfterEntryIds).toEqual(["t1"]);
    expect(result.cells[0]?.sourceEntryIds).toEqual(["u1", "a1", "t1"]);
  });
});
