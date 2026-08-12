import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";

/** Stable project identity shared by storage, recall, and framework adapters. */
export interface ProjectIdentity {
  /** Portable slug plus hash used as the project-scoped storage key. */
  readonly projectId: string;
  /** Canonical path whose normalized value produced projectId. */
  readonly identityRoot: string;
  /** Detected checkout root, or null when the path is not inside Git. */
  readonly gitRoot: string | null;
  /** Checkout-specific identity used to isolate local memory across Git worktrees. */
  readonly worktreeId: string;
}

/** Resolves worktrees to one repository identity while isolating unrelated directories. */
export async function resolveProjectIdentity(startPath: string): Promise<ProjectIdentity> {
  const projectRoot = await canonicalPath(startPath);
  const gitRoot = await findGitRoot(projectRoot);
  const identityRoot = gitRoot ? await resolveCanonicalGitRoot(gitRoot) : projectRoot;
  return {
    projectId: createProjectId(identityRoot),
    identityRoot,
    gitRoot,
    worktreeId: createWorktreeId(gitRoot ?? projectRoot),
  };
}

/** Creates a readable, collision-resistant storage id from a canonical path. */
export function createProjectId(identityRoot: string): string {
  const normalized = identityRoot.normalize("NFC");
  const slug = normalized.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 80) || "project";
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `${slug}--${hash}`;
}

/** Creates a stable checkout key while projectId continues to unify worktrees. */
export function createWorktreeId(worktreeRoot: string): string {
  return createHash("sha256").update(worktreeRoot.normalize("NFC")).digest("hex").slice(0, 16);
}

/** Walks upward to find a directory or worktree-file `.git` marker. */
export async function findGitRoot(startPath: string): Promise<string | null> {
  let current = await canonicalPath(startPath);
  const filesystemRoot = parse(current).root;
  while (true) {
    try {
      const metadata = await stat(join(current, ".git"));
      if (metadata.isDirectory() || metadata.isFile()) return current;
    } catch {
      // Walk to the parent until the filesystem root is reached.
    }
    if (current === filesystemRoot) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Resolves a valid Git worktree to the main repository root. */
export async function resolveCanonicalGitRoot(gitRoot: string): Promise<string> {
  const root = await canonicalPath(gitRoot);
  try {
    const dotGitPath = join(root, ".git");
    const gitFile = (await readFile(dotGitPath, "utf8")).trim();
    if (!gitFile.startsWith("gitdir:")) return root;
    const worktreeGitDir = resolve(root, gitFile.slice("gitdir:".length).trim());
    const commonDir = resolve(
      worktreeGitDir,
      (await readFile(join(worktreeGitDir, "commondir"), "utf8")).trim(),
    );

    if (resolve(dirname(worktreeGitDir)) !== join(commonDir, "worktrees")) return root;
    const backlink = await realpath((await readFile(join(worktreeGitDir, "gitdir"), "utf8")).trim());
    if (backlink !== await realpath(dotGitPath)) return root;

    if (basename(commonDir) !== ".git") return (await canonicalPath(commonDir)).normalize("NFC");
    return (await canonicalPath(dirname(commonDir))).normalize("NFC");
  } catch {
    // Regular repositories, submodules, and malformed worktree metadata keep
    // their own root instead of trusting an attacker-controlled commondir.
    return root;
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return (await realpath(path)).normalize("NFC");
  } catch {
    return resolve(path).normalize("NFC");
  }
}
