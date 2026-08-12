import { describe, expect, it } from "vitest";
import { createMemoryRecord } from "./memory-record.js";
import { buildMemoryIndex, MEMORY_INDEX_MAX_BYTES, MEMORY_INDEX_MAX_LINES } from "./memory-index.js";

describe("MEMORY.md index", () => {
  it("contains only concise pointers to active topic files", () => {
    const active = createMemoryRecord({ id: "pnpm", name: "Use pnpm", description: "Preferred package manager", content: "details", type: "user", scope: "user" });
    const archived = { ...active, id: "old", status: "archived" as const };
    const index = buildMemoryIndex([archived, active]);
    expect(index).toContain("[Use pnpm](pnpm.md) — Preferred package manager");
    expect(index).not.toContain("details");
    expect(index).not.toContain("old.md");
  });

  it("enforces the Claude entrypoint line and byte caps", () => {
    const records = Array.from({ length: 300 }, (_, index) => createMemoryRecord({
      id: `m-${index}`, name: `Memory ${index}`, description: "x".repeat(500), content: "detail", type: "reference", scope: "user",
    }));
    const output = buildMemoryIndex(records);
    expect(output.trimEnd().split("\n").length).toBeLessThanOrEqual(MEMORY_INDEX_MAX_LINES);
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(MEMORY_INDEX_MAX_BYTES);
  });
});
