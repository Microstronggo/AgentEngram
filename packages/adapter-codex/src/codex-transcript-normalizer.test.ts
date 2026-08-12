import { appendFile, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeCodexRolloutLine,
  normalizeCodexHookEvent,
  readCodexRollout,
  readCodexRolloutIncremental,
  readFileRangeFully,
} from "./codex-transcript-normalizer.js";

describe("Codex rollout normalization", () => {
  it("projects messages, tool calls, tool results, and compact markers", () => {
    const message = normalizeCodexRolloutLine(line(1, "response_item", {
      type: "message", role: "user", content: [{ type: "input_text", text: "Remember the commit rule." }],
    }, "turn-1"));
    const call = normalizeCodexRolloutLine(line(2, "response_item", {
      type: "function_call", name: "exec_command", call_id: "call-1", arguments: "{\"cmd\":\"git status\"}",
    }, "turn-1"));
    const result = normalizeCodexRolloutLine(line(3, "response_item", {
      type: "function_call_output", call_id: "call-1", output: "clean",
    }, "turn-1"));
    const compact = normalizeCodexRolloutLine(line(4, "compacted", {
      window_id: "window-2",
      message: { content: [{ type: "input_text", text: "Summary of prior work." }] },
      replacement_history: [{ type: "message", role: "user" }],
    }, "turn-1"));

    expect(message.normalized).toMatchObject({ kind: "message", role: "user", text: "Remember the commit rule." });
    expect(call.normalized).toMatchObject({ kind: "tool_call", toolName: "exec_command", toolCallId: "call-1" });
    expect(result.normalized).toMatchObject({ kind: "tool_result", toolCallId: "call-1", text: "clean" });
    expect(compact.normalized).toMatchObject({ kind: "compaction", text: "Summary of prior work." });
    expect(compact.normalized?.text).not.toContain("replacement_history");
  });

  it("keeps reasoning only in raw truth and stops at an incomplete JSONL tail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentengram-codex-rollout-"));
    const path = join(directory, "rollout.jsonl");
    await writeFile(path, [
      JSON.stringify({ timestamp: "2026-06-30T00:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-1" } }),
      JSON.stringify({ timestamp: "2026-06-30T00:00:01.000Z", type: "response_item", payload: { type: "reasoning", summary: ["private"] } }),
      JSON.stringify({ timestamp: "2026-06-30T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } }),
      "{\"timestamp\":",
    ].join("\n"), "utf8");

    const records = await readCodexRollout({ path, sessionId: "session-1", threadId: "thread-1" });
    expect(records).toHaveLength(3);
    expect(records[1]?.raw.rawFrameworkPayload).toMatchObject({ payload: { type: "reasoning" } });
    expect(records[1]?.normalized).toBeUndefined();
    expect(records[2]?.normalized).toMatchObject({ role: "assistant", text: "Done." });
  });

  it("resumes from a byte checkpoint while retaining split UTF-8 and turn parser state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentengram-codex-incremental-"));
    const path = join(directory, "rollout.jsonl");
    const turn = `${JSON.stringify({
      timestamp: "2026-06-30T00:00:00.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-incremental" },
    })}\n`;
    const assistant = `${JSON.stringify({
      timestamp: "2026-06-30T00:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "增量完成" }] },
    })}\n`;
    const encoded = Buffer.from(assistant, "utf8");
    const split = encoded.indexOf(Buffer.from("增", "utf8")) + 1;
    await writeFile(path, Buffer.concat([Buffer.from(turn), encoded.subarray(0, split)]));

    const first = await readCodexRolloutIncremental({ path, sessionId: "session-1", threadId: "thread-1" });
    expect(first.records).toHaveLength(1);
    expect(first.checkpoint?.partialTail).toBeTruthy();
    expect(first.checkpoint?.parserState).toMatchObject({ currentTurnId: "turn-incremental", lineNumber: 1 });

    await appendFile(path, encoded.subarray(split));
    const second = await readCodexRolloutIncremental({
      path,
      sessionId: "session-1",
      threadId: "thread-1",
      checkpoint: first.checkpoint,
    });
    expect(second.records).toHaveLength(1);
    expect(second.records[0]?.normalized).toMatchObject({
      role: "assistant",
      text: "增量完成",
      metadata: { turnId: "turn-incremental" },
    });
    expect(second.checkpoint?.partialTail).toBeUndefined();
    expect(second.checkpoint?.parserState).toMatchObject({ currentTurnId: "turn-incremental", lineNumber: 2 });

    const third = await readCodexRolloutIncremental({
      path,
      sessionId: "session-1",
      threadId: "thread-1",
      checkpoint: second.checkpoint,
    });
    expect(third.records).toEqual([]);
  });

  it("resets its parser state when the rollout file is atomically replaced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentengram-codex-rollout-replace-"));
    const path = join(directory, "rollout.jsonl");
    await writeFile(path, `${JSON.stringify({
      timestamp: "2026-06-30T00:00:00.000Z",
      type: "turn_context",
      payload: { turn_id: "old-turn" },
    })}\n`, "utf8");
    const first = await readCodexRolloutIncremental({ path, sessionId: "session-1", threadId: "thread-1" });
    const replacement = join(directory, "replacement.jsonl");
    await writeFile(replacement, `${JSON.stringify({
      timestamp: "2026-07-01T00:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "New rollout" }] },
    })}\n`, "utf8");
    await rename(replacement, path);

    const next = await readCodexRolloutIncremental({
      path,
      sessionId: "session-1",
      threadId: "thread-1",
      checkpoint: first.checkpoint,
    });
    expect(next.reset).toBe(true);
    expect(next.records[0]?.normalized).toMatchObject({ text: "New rollout" });
    expect(next.records[0]?.raw.id).not.toBe(first.records[0]?.raw.id);
  });

  it("continues positional reads until a short-reading filesystem reaches the requested end", async () => {
    const source = Buffer.from("short reads must not advance past evidence", "utf8");
    const positions: number[] = [];
    const result = await readFileRangeFully({
      read: async (buffer, offset, length, position) => {
        positions.push(position);
        const bytesRead = Math.min(3, length, source.length - position);
        if (bytesRead <= 0) return { bytesRead: 0 };
        source.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
      },
    }, 0, source.length);

    expect(result.bytes.toString("utf8")).toBe(source.toString("utf8"));
    expect(result.endOffset).toBe(source.length);
    expect(positions.length).toBeGreaterThan(1);

    const truncated = await readFileRangeFully({
      read: async (buffer, offset, length, position) => {
        const bytesRead = Math.min(length, Math.max(0, 5 - position));
        if (bytesRead > 0) source.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
      },
    }, 0, source.length);
    expect(truncated.bytes.length).toBe(5);
    expect(truncated.endOffset).toBe(5);
  });

  it("detects same-inode truncate and regrow using the checkpoint content anchor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentengram-codex-rollout-regrow-"));
    const path = join(directory, "rollout.jsonl");
    const oldContent = `${JSON.stringify({
      timestamp: "2026-06-30T00:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Old rollout evidence" }] },
    })}\n`;
    await writeFile(path, oldContent, "utf8");
    const first = await readCodexRolloutIncremental({ path, sessionId: "session-1", threadId: "thread-1" });

    // writeFile truncates and rewrites the existing inode. Make the replacement
    // longer than the previous cursor so size-only truncation detection cannot help.
    const replacementContent = `${JSON.stringify({
      timestamp: "2026-07-01T00:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Replacement rollout evidence that is intentionally longer" }] },
    })}\n`;
    await writeFile(path, replacementContent, "utf8");
    expect(Buffer.byteLength(replacementContent)).toBeGreaterThan(Buffer.byteLength(oldContent));

    const next = await readCodexRolloutIncremental({
      path,
      sessionId: "session-1",
      threadId: "thread-1",
      checkpoint: first.checkpoint,
    });
    expect(next.reset).toBe(true);
    expect(next.checkpoint?.sourceVersion).toBe(first.checkpoint?.sourceVersion);
    expect(next.records).toHaveLength(1);
    expect(next.records[0]?.normalized).toMatchObject({ text: expect.stringContaining("Replacement rollout evidence") });
  });

  it("records only authoritative Subagent lineage exposed by Codex", () => {
    const event = normalizeCodexHookEvent({
      session_id: "root-session",
      turn_id: "spawn-turn",
      agent_id: "child-agent",
      agent_type: "explorer",
      transcript_path: null,
      cwd: "/project",
      hook_event_name: "SubagentStart",
      model: "gpt-test",
      permission_mode: "default",
    }, "child-agent");

    expect(event.raw.frameworkThreadId).toBe("child-agent");
    expect(event.raw.metadata).toMatchObject({
      parentThreadId: "root-session",
      turnId: "spawn-turn",
      agentId: "child-agent",
      agentType: "explorer",
    });
  });

  it("reads a long rollout once and then processes only the appended delta", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentengram-codex-long-rollout-"));
    const path = join(directory, "rollout.jsonl");
    const rows = Array.from({ length: 10_000 }, (_, index) => JSON.stringify({
      timestamp: "2026-07-19T00:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `message-${index}` }] },
    })).join("\n") + "\n";
    await writeFile(path, rows, "utf8");
    const startedAt = performance.now();
    const initial = await readCodexRolloutIncremental({ path, sessionId: "long-session", threadId: "long-thread" });
    const initialDurationMs = performance.now() - startedAt;
    expect(initial.records).toHaveLength(10_000);
    expect(initialDurationMs).toBeLessThan(10_000);

    await appendFile(path, `${JSON.stringify({
      timestamp: "2026-07-19T00:01:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "delta-only" }] },
    })}\n`, "utf8");
    const deltaStartedAt = performance.now();
    const delta = await readCodexRolloutIncremental({
      path, sessionId: "long-session", threadId: "long-thread", checkpoint: initial.checkpoint,
    });
    expect(delta.records).toHaveLength(1);
    expect(delta.records[0]?.normalized).toMatchObject({ text: "delta-only" });
    expect(performance.now() - deltaStartedAt).toBeLessThan(Math.max(1_000, initialDurationMs));
  });
});

function line(lineNumber: number, type: string, payload: Record<string, unknown>, currentTurnId?: string) {
  return {
    sessionId: "session-1",
    threadId: "thread-1",
    lineNumber,
    line: { timestamp: `2026-06-30T00:00:0${lineNumber}.000Z`, type, payload },
    ...(currentTurnId ? { currentTurnId } : {}),
  };
}
