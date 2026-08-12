import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../protocol/message.js";
import {
  AutoCompactCircuitBreaker,
  summarizeWithCircuitBreaker,
  summarizeWithCompactRetries,
} from "./compact-resilience.js";

const text = (id: string, value = id, role: AgentMessage["role"] = "user"): AgentMessage => ({
  id,
  role,
  content: [{ type: "text", text: value }],
});

describe("Compact resilience", () => {
  it("drops oldest API rounds and retries when the summary request itself is too long", async () => {
    const summarize = vi.fn()
      .mockRejectedValueOnce(new Error("prompt too long"))
      .mockResolvedValueOnce({ text: "summary", model: "fake" });

    const result = await summarizeWithCompactRetries({
      summarizer: { summarize },
      messages: [text("old-1"), text("old-2"), text("tail")],
      apiRounds: [[text("old-1")], [text("old-2")], [text("tail")]],
      instructions: ["summarize"],
    });

    expect(result.summary.text).toBe("summary");
    expect(result.decisions).toEqual([{
      kind: "prompt-too-long-truncation",
      attempt: 1,
      droppedMessageIds: ["old-1"],
      remainingMessageIds: ["old-2", "tail"],
    }]);
    expect(summarize).toHaveBeenLastCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({ id: "old-2" }), expect.objectContaining({ id: "tail" })],
    }));
  });

  it("retries transient streaming failures independently of prompt-too-long retries", async () => {
    const summarize = vi.fn()
      .mockRejectedValueOnce(new Error("stream ended without assistant response"))
      .mockResolvedValueOnce({ text: "summary", model: "fake" });

    const result = await summarizeWithCompactRetries({
      summarizer: { summarize },
      messages: [text("m1")],
      instructions: ["summarize"],
      maxStreamingRetries: 1,
    });

    expect(result.decisions).toEqual([{ kind: "streaming-retry", attempt: 1 }]);
    expect(result.summary.text).toBe("summary");
  });

  it("opens the autocompact circuit after three consecutive failures and resets on success", async () => {
    const breaker = new AutoCompactCircuitBreaker(3);
    const failing = {
      summarizer: { summarize: async () => { throw new Error("no response"); } },
      messages: [text("m")],
      instructions: ["summarize"],
      maxStreamingRetries: 0,
    };

    await expect(summarizeWithCircuitBreaker(breaker, failing)).rejects.toThrow("no response");
    await expect(summarizeWithCircuitBreaker(breaker, failing)).rejects.toThrow("no response");
    await expect(summarizeWithCircuitBreaker(breaker, failing)).rejects.toThrow("no response");
    await expect(summarizeWithCircuitBreaker(breaker, failing)).resolves.toMatchObject({
      status: "skipped",
      reason: "circuit-open",
    });

    const healthy = new AutoCompactCircuitBreaker(3);
    healthy.recordFailure();
    await expect(summarizeWithCircuitBreaker(healthy, {
      summarizer: { summarize: async () => ({ text: "ok", model: "fake" }) },
      messages: [text("m")],
      instructions: ["summarize"],
    })).resolves.toMatchObject({ status: "completed" });
    expect(healthy.state).toEqual({ consecutiveFailures: 0, disabled: false });
  });
});
