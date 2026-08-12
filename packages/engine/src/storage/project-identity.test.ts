import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectId, resolveProjectIdentity } from "./project-identity.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("project identity", () => {
  it("adds a hash so sanitized path collisions remain distinct", () => {
    expect(createProjectId("/a-b")).not.toBe(createProjectId("/a/b"));
  });

  it("uses the same identity for a repository and a valid worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentengram-project-"));
    temporaryDirectories.push(root);
    const main = join(root, "main");
    const worktree = join(root, "feature");
    const worktreeGitDir = join(main, ".git", "worktrees", "feature");
    await mkdir(worktreeGitDir, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");
    await writeFile(join(worktreeGitDir, "commondir"), "../..\n", "utf8");
    await writeFile(join(worktreeGitDir, "gitdir"), `${join(worktree, ".git")}\n`, "utf8");

    const mainIdentity = await resolveProjectIdentity(main);
    const worktreeIdentity = await resolveProjectIdentity(worktree);
    expect(worktreeIdentity.identityRoot).toBe(mainIdentity.identityRoot);
    expect(worktreeIdentity.projectId).toBe(mainIdentity.projectId);
    expect(worktreeIdentity.worktreeId).not.toBe(mainIdentity.worktreeId);
  });
});
