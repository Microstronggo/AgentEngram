import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHostBinding, type HostIdentity } from "../protocol/host-identity.js";
import { FileHostBindingRepository } from "./host-binding-repository.js";

const identity = (session: string): HostIdentity => ({
  hostType: "codex",
  hostProjectId: "project-a",
  hostSessionId: session,
  hostThreadId: "main",
});

describe("FileHostBindingRepository", () => {
  it("persists and atomically replaces one exact host binding", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agentengram-host-binding-"));
    const repository = new FileHostBindingRepository(rootDir);
    await repository.save(createHostBinding(identity("session-a")));
    await repository.save(createHostBinding(identity("session-a"), { namespaceId: "portable-project", threadId: "portable-thread" }));

    await expect(repository.load(identity("session-a"))).resolves.toMatchObject({
      namespaceId: "portable-project",
      threadId: "portable-thread",
    });
    expect((await readdir(rootDir)).every((name) => name.endsWith(".json"))).toBe(true);
  });

  it("never guesses a binding across sessions with the same project and thread", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agentengram-host-binding-isolation-"));
    const repository = new FileHostBindingRepository(rootDir);
    await repository.save(createHostBinding(identity("session-a"), { threadId: "portable-a" }));

    await expect(repository.load(identity("session-b"))).resolves.toBeUndefined();
    await repository.save(createHostBinding(identity("session-b"), { threadId: "portable-b" }));
    await expect(repository.load(identity("session-a"))).resolves.toMatchObject({ threadId: "portable-a" });
    await expect(repository.load(identity("session-b"))).resolves.toMatchObject({ threadId: "portable-b" });
  });

  it("removes only the exact requested host binding", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agentengram-host-binding-remove-"));
    const repository = new FileHostBindingRepository(rootDir);
    await repository.save(createHostBinding(identity("session-a")));
    await repository.save(createHostBinding(identity("session-b")));
    await repository.remove(identity("session-a"));

    await expect(repository.load(identity("session-a"))).resolves.toBeUndefined();
    await expect(repository.load(identity("session-b"))).resolves.toBeDefined();
  });

  it("lists validated bindings in stable host identity order", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agentengram-host-binding-list-"));
    const repository = new FileHostBindingRepository(rootDir);
    await repository.save(createHostBinding(identity("session-b")));
    await repository.save(createHostBinding(identity("session-a")));

    expect((await repository.list()).map(({ identity: value }) => value.hostSessionId))
      .toEqual(["session-a", "session-b"]);
  });

  it("normalizes text fields and rejects non-string optional identity fields from disk", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agentengram-host-binding-validation-"));
    const repository = new FileHostBindingRepository(rootDir);
    await repository.save(createHostBinding({
      ...identity(" session-a "),
      hostProjectId: " project-a ",
      worktreeId: " worktree-a ",
    }));
    await expect(repository.load(identity("session-a"))).resolves.toMatchObject({
      identity: { hostProjectId: "project-a", hostSessionId: "session-a", worktreeId: "worktree-a" },
    });

    await expect(repository.save({
      namespaceId: "project-a",
      threadId: "main",
      identity: { ...identity("session-b"), worktreeId: 123 } as unknown as HostIdentity,
    })).rejects.toThrow("worktreeId must be a string");
  });
});
