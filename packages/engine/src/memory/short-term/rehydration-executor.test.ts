import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../protocol/message.js";
import { executeRehydration, type RehydrationProvider } from "./rehydration-executor.js";

const estimate = (value: unknown): number => typeof value === "string" ? value.length : JSON.stringify(value).length;
const message = (id: string, text: string): AgentMessage => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
});

describe("RehydrationExecutor", () => {
  it("restores post-compact working context in priority order with provenance", async () => {
    const providers: RehydrationProvider[] = [
      { kind: "skill", load: async () => [{ id: "skill-1", kind: "skill", priority: 1, message: message("skill", "skill guide"), sourceRef: "skill.md" }] },
      { kind: "plan", load: async () => [{ id: "plan-1", kind: "plan", message: message("plan", "current plan"), sourceRef: "plan.md" }] },
    ];

    const result = await executeRehydration({ providers, totalBudgetTokens: 1_000, estimator: estimate });

    expect(result.messages.map(({ id }) => id)).toEqual(["plan", "skill"]);
    expect(result.messages[0]?.metadata).toMatchObject({
      rehydrated: true,
      rehydrationKind: "plan",
      sourceRef: "plan.md",
    });
    expect(result.decisions.every((decision) => decision.included)).toBe(true);
  });

  it("applies total and per-kind token budgets", async () => {
    const providers: RehydrationProvider[] = [
      { kind: "recent-file", load: async () => [
        { id: "file-1", kind: "recent-file", message: message("file-1", "a".repeat(10)), sourceRef: "a.ts" },
        { id: "file-2", kind: "recent-file", message: message("file-2", "b".repeat(10)), sourceRef: "b.ts" },
      ] },
      { kind: "plan", load: async () => [{ id: "plan-1", kind: "plan", message: message("plan", "plan"), sourceRef: "plan.md" }] },
    ];

    const result = await executeRehydration({
      providers,
      totalBudgetTokens: 1_000,
      perKindBudgetTokens: { "recent-file": 10 },
      estimator: estimate,
    });

    expect(result.messages.map(({ id }) => id)).toEqual(["plan", "file-1"]);
    expect(result.decisions.find((decision) => decision.itemId === "file-2")).toMatchObject({
      included: false,
      reason: "budget-exceeded",
    });
  });
});
