const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

/** Creates an AgentEngram URI for one canonical transcript entry. */
export function createTranscriptSourceRef(input: {
  readonly sessionId: string;
  readonly threadId: string;
  readonly entryId: string;
}): string {
  const sessionId = assertSafeId(input.sessionId, "sessionId");
  const threadId = assertSafeId(input.threadId, "threadId");
  const entryId = assertSafeId(input.entryId, "entryId");
  return `agentengram://transcript/${sessionId}/${threadId}/${entryId}`;
}

/** Creates a provider-specific URI while validating every path segment. */
export function createFrameworkSourceRef(input: {
  readonly framework: "pi" | string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly entryId: string;
}): string {
  const framework = assertSafeId(input.framework, "framework");
  const sessionId = assertSafeId(input.sessionId, "sessionId");
  const threadId = assertSafeId(input.threadId, "threadId");
  const entryId = assertSafeId(input.entryId, "entryId");
  return `${framework}://session/${sessionId}/thread/${threadId}/entry/${entryId}`;
}

/** Rejects empty or path-like identifiers before they enter URIs or storage paths. */
export function assertSafeId(value: string, field = "id"): string {
  if (!SAFE_ID.test(value) || value === "." || value === "..") {
    throw new Error(`unsafe ${field}`);
  }
  return value;
}
