import {
  createHostBinding,
  resolveProjectIdentity,
  type HostBinding,
  type ProjectIdentity,
} from "@agentengram/engine";
import type { EngineFacade } from "./types.js";

/** Trusted Pi identity input assembled exclusively from ExtensionContext. */
export interface PiHostBindingInput {
  readonly cwd: string;
  readonly sessionId: string;
  readonly threadId: string;
  /** Optional namespace override may come only from adapter configuration. */
  readonly namespaceId?: string;
}

/** Host binding plus the canonical checkout identity used by memory scopes. */
export interface ResolvedPiHostBinding {
  readonly binding: HostBinding;
  readonly project: ProjectIdentity;
}

/**
 * Maps Pi-local session identities into AgentEngram's portable namespace.
 * The canonical repository id is shared by Pi, Codex, and other adapters that
 * resolve the same checkout, while the host session/thread remain traceable.
 */
export async function resolvePiHostBinding(input: PiHostBindingInput): Promise<ResolvedPiHostBinding> {
  const project = await resolveProjectIdentity(input.cwd);
  const binding = createHostBinding({
    hostType: "pi",
    hostProjectId: project.projectId,
    hostSessionId: input.sessionId,
    hostThreadId: input.threadId,
    worktreeId: project.worktreeId,
  }, {
    ...(input.namespaceId === undefined ? {} : { namespaceId: input.namespaceId }),
  });
  return { binding, project };
}

/**
 * Prefers the production facade's durable exact mapping and retains the pure
 * deterministic resolver for injected/test facades that do not own storage.
 */
export async function resolveEnginePiHostBinding(
  engine: EngineFacade,
  input: PiHostBindingInput,
): Promise<HostBinding> {
  const durable = await engine.resolveHostBinding?.({
    cwd: input.cwd,
    sessionId: input.sessionId,
    threadId: input.threadId,
  });
  if (durable) return durable;
  return (await resolvePiHostBinding(input)).binding;
}
