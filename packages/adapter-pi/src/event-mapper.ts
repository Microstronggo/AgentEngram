import type { PiContext, PiSessionManager } from "./pi-types.js";
import type { AdapterEvent } from "./types.js";

// Pi's leaf id advances for every appended message/custom entry. Capture a
// branch anchor at session start/tree navigation instead of treating that
// moving cursor as a durable AgentEngram thread id.
const threadAnchors = new WeakMap<PiSessionManager, string>();

export function piIdentity(context: PiContext): { sessionId: string; threadId: string } {
  const sessionFile = context.sessionManager.getSessionFile();
  const sessionId = context.sessionManager.getSessionId?.() ?? sessionFile ?? `cwd:${context.cwd}`;
  const threadId = threadAnchors.get(context.sessionManager)
    ?? setThreadAnchor(context.sessionManager, context.sessionManager.getLeafId?.() ?? `session:${sessionId}`);
  return { sessionId, threadId };
}

export function resetPiThreadIdentity(context: PiContext): void {
  const sessionFile = context.sessionManager.getSessionFile();
  const sessionId = context.sessionManager.getSessionId?.() ?? sessionFile ?? `cwd:${context.cwd}`;
  setThreadAnchor(context.sessionManager, context.sessionManager.getLeafId?.() ?? `session:${sessionId}`);
}

export function updatePiTreeIdentity(context: PiContext, newLeafId: unknown): void {
  const sessionFile = context.sessionManager.getSessionFile();
  const sessionId = context.sessionManager.getSessionId?.() ?? sessionFile ?? `cwd:${context.cwd}`;
  const anchor = typeof newLeafId === "string"
    ? newLeafId
    : context.sessionManager.getLeafId?.() ?? `root:${sessionId}`;
  setThreadAnchor(context.sessionManager, anchor);
}

function setThreadAnchor(manager: PiSessionManager, anchor: string): string {
  threadAnchors.set(manager, anchor);
  return anchor;
}

export function mapPiEvent(type: string, payload: unknown, context: PiContext): AdapterEvent {
  const sessionFile = context.sessionManager.getSessionFile();
  const identity = piIdentity(context);
  return {
    type: `pi.${type}`,
    occurredAt: new Date().toISOString(),
    cwd: context.cwd,
    ...identity,
    payload,
    ...(sessionFile === undefined ? {} : { sessionFile }),
  };
}
