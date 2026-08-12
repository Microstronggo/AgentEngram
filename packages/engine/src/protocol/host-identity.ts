/** Stable identity supplied by a trusted host adapter, never by model output. */
export interface HostIdentity {
  /** Adapter family such as `pi` or `codex`. */
  readonly hostType: string;
  /** Host-side project identity retained for traceability. */
  readonly hostProjectId: string;
  /** Host-side session identity retained for transcript source references. */
  readonly hostSessionId: string;
  /** Host-side branch/thread identity. */
  readonly hostThreadId: string;
  readonly worktreeId?: string;
  readonly parentThreadId?: string;
  readonly agentId?: string;
  readonly userId?: string;
}

/**
 * Trusted mapping from host-local identities to AgentEngram's portable
 * namespace and thread identities.
 */
export interface HostBinding {
  readonly namespaceId: string;
  readonly threadId: string;
  readonly identity: HostIdentity;
}

/** Optional overrides supplied only by trusted adapter configuration. */
export interface HostBindingOptions {
  readonly namespaceId?: string;
  readonly threadId?: string;
}

/**
 * Creates the conservative V1 binding: a canonical host project is the
 * default portable namespace and a host thread remains the default thread.
 */
export function createHostBinding(identity: HostIdentity, options: HostBindingOptions = {}): HostBinding {
  const normalizedIdentity = normalizeHostIdentity(identity);
  const namespaceId = requiredIdentityPart(options.namespaceId ?? identity.hostProjectId, "namespaceId");
  const threadId = requiredIdentityPart(options.threadId ?? identity.hostThreadId, "threadId");
  return { namespaceId, threadId, identity: normalizedIdentity };
}

/** Rejects incomplete trusted identities before they reach storage paths. */
export function validateHostIdentity(identity: HostIdentity): void {
  normalizeHostIdentity(identity);
}

/** Trims every trusted identity component and rejects non-string optional fields. */
export function normalizeHostIdentity(identity: HostIdentity): HostIdentity {
  const normalized: Record<string, string> = {
    hostType: requiredIdentityPart(identity.hostType, "hostType"),
    hostProjectId: requiredIdentityPart(identity.hostProjectId, "hostProjectId"),
    hostSessionId: requiredIdentityPart(identity.hostSessionId, "hostSessionId"),
    hostThreadId: requiredIdentityPart(identity.hostThreadId, "hostThreadId"),
  };
  for (const name of ["worktreeId", "parentThreadId", "agentId", "userId"] as const) {
    const value = identity[name];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`${name} must be a string`);
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${name} must not be blank`);
    normalized[name] = trimmed;
  }
  return normalized as unknown as HostIdentity;
}

function requiredIdentityPart(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}
