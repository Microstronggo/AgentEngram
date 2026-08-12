import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SourceCheckpoint, SourceCheckpointRepository } from "@agentengram/engine";
import { mirrorCodexHookTranscript } from "./hook-runtime.js";
import type { CodexHookInput } from "./types.js";

describe("Codex Hook transcript ingestion", () => {
  it("does not advance the source checkpoint when portable transcript persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentengram-codex-checkpoint-failure-"));
    const rollout = join(directory, "rollout.jsonl");
    await writeFile(rollout, `${JSON.stringify({
      timestamp: "2026-07-01T00:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Remember this" }] },
    })}\n`, "utf8");
    const repository = new MemoryCheckpointRepository();
    const appendTranscript = vi.fn(async () => {
      throw new Error("injected transcript failure");
    });

    await expect(mirrorCodexHookTranscript(
      { appendTranscript },
      hookInput(directory, rollout),
      "session-1",
      repository,
    )).rejects.toThrow("injected transcript failure");

    expect(repository.saved).toEqual([]);
    expect(appendTranscript).toHaveBeenCalledOnce();
  });
});

class MemoryCheckpointRepository implements SourceCheckpointRepository {
  readonly saved: SourceCheckpoint[] = [];

  async load(): Promise<SourceCheckpoint | undefined> {
    return undefined;
  }

  async save(checkpoint: SourceCheckpoint): Promise<void> {
    this.saved.push(checkpoint);
  }

  async remove(): Promise<void> {}
}

function hookInput(cwd: string, transcriptPath: string): CodexHookInput {
  return {
    session_id: "session-1",
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: "SessionStart",
    model: "gpt-test",
    permission_mode: "default",
    source: "startup",
  };
}
