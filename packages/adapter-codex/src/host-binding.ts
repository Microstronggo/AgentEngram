import { join } from "node:path";
import {
  FileHostBindingRepository,
  createHostBinding,
  type HostBinding,
  type ProjectIdentity,
} from "@agentengram/engine";
import type { CodexHookInput } from "./types.js";

/** Trusted Codex binding state derived only from command-hook fields and cwd identity. */
export interface CodexHostBindings {
  /** Binding for the main session or the child Agent addressed by this Hook. */
  readonly active: HostBinding;
  /** Root binding persisted alongside a child even if SessionStart was missed. */
  readonly root?: HostBinding;
}

/**
 * Maps Codex's root session and optional child agent id into portable Runtime
 * identities. Codex exposes no nested parent id, so child lineage is anchored
 * to the root session and the spawning turn remains in transcript metadata.
 */
export function createCodexHostBindings(input: CodexHookInput, project: ProjectIdentity): CodexHostBindings {
  const root = createHostBinding({
    hostType: "codex",
    hostProjectId: project.projectId,
    hostSessionId: input.session_id,
    hostThreadId: input.session_id,
    worktreeId: project.worktreeId,
  });
  if (!input.agent_id) return { active: root };
  return {
    root,
    active: createHostBinding({
      hostType: "codex",
      hostProjectId: project.projectId,
      hostSessionId: input.session_id,
      hostThreadId: input.agent_id,
      worktreeId: project.worktreeId,
      parentThreadId: input.session_id,
      agentId: input.agent_id,
    }),
  };
}

/** Persists exact root/child bindings before transcript facts reference them. */
export async function persistCodexHostBindings(homeDir: string, bindings: CodexHostBindings): Promise<void> {
  const repository = new FileHostBindingRepository(join(homeDir, "host-bindings"));
  if (bindings.root) await repository.save(bindings.root);
  await repository.save(bindings.active);
}
