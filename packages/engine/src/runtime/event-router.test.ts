import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../protocol/index.js";
import { EventRouter } from "./event-router.js";

function turnCompleted(eventId = "event-1"): AgentEvent {
  return {
    eventId,
    eventType: "turn.completed",
    timestamp: "2026-06-22T00:00:00.000Z",
    framework: "test",
    sessionId: "session-1",
    threadId: "thread-1",
    turnId: "turn-1",
    payload: { turnId: "turn-1" },
  };
}

describe("EventRouter", () => {
  it("processes repeated event ids exactly once", async () => {
    const handler = vi.fn();
    const router = new EventRouter([handler]);

    expect(await router.dispatch(turnCompleted())).toEqual({ applied: true });
    expect(await router.dispatch(turnCompleted())).toEqual({ applied: false, reason: "duplicate" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(router.session("session-1")?.snapshot()).toMatchObject({
      eventCount: 1,
      completedTurns: 1,
    });
  });

  it("keeps failed handler deliveries retryable", async () => {
    let fail = true;
    const router = new EventRouter([() => {
      if (fail) throw new Error("temporary");
    }]);

    await expect(router.dispatch(turnCompleted())).rejects.toThrow("temporary");
    fail = false;
    await expect(router.dispatch(turnCompleted())).resolves.toEqual({ applied: true });
    expect(router.session("session-1")?.snapshot().eventCount).toBe(1);
  });
});
