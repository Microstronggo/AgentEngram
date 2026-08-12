import type { FrameworkCapabilities } from "../protocol/capabilities.js";
import type {
  ContextFallbackReason,
  ContextIntegrationIntent,
  ContextOwnershipDiagnostic,
  ManagedFailurePolicy,
} from "../protocol/context-view.js";

/** Inputs needed to negotiate context ownership before a host callback runs. */
export interface ContextOwnershipRequest {
  readonly requestedMode: ContextIntegrationIntent;
  readonly capabilities: Pick<FrameworkCapabilities, "replaceContext" | "replaceCompaction">;
  /** True only when compact, checkpoint, and recovery dependencies are ready. */
  readonly managedRuntimeReady: boolean;
  readonly failurePolicy?: ManagedFailurePolicy;
}

/** Configuration error raised instead of silently pretending managed ownership. */
export class ContextOwnershipError extends Error {
  public constructor(readonly reason: ContextFallbackReason) {
    super(contextOwnershipErrorMessage(reason));
    this.name = "ContextOwnershipError";
  }
}

/**
 * Resolves install intent conservatively. `auto` never transfers ownership;
 * explicit managed-context succeeds only when the entire lifecycle is ready.
 */
export function resolveContextOwnership(request: ContextOwnershipRequest): ContextOwnershipDiagnostic {
  const failurePolicy = request.failurePolicy ?? "host-fallback";
  if (request.requestedMode !== "managed-context") {
    return {
      requestedMode: request.requestedMode,
      effectiveMode: "enhance",
      contextOwner: "host",
      compactionOwner: "host",
      failurePolicy,
      fallbackCount: 0,
    };
  }

  if (!request.capabilities.replaceContext) throw new ContextOwnershipError("host-cannot-replace-context");
  if (!request.capabilities.replaceCompaction) throw new ContextOwnershipError("host-cannot-replace-compaction");
  if (!request.managedRuntimeReady) throw new ContextOwnershipError("managed-runtime-unavailable");

  return {
    requestedMode: "managed-context",
    effectiveMode: "managed-context",
    contextOwner: "agentengram",
    compactionOwner: "agentengram",
    failurePolicy,
    fallbackCount: 0,
  };
}

/**
 * Records a runtime fallback without losing the original requested mode. A
 * strict policy raises instead, allowing the caller to stop a corrupted view.
 */
export function fallbackContextOwnership(
  ownership: ContextOwnershipDiagnostic,
  reason: ContextFallbackReason,
): ContextOwnershipDiagnostic {
  if (ownership.failurePolicy === "strict") throw new ContextOwnershipError(reason);
  return {
    ...ownership,
    effectiveMode: "enhance",
    contextOwner: "host",
    compactionOwner: "host",
    fallbackReason: reason,
    fallbackCount: ownership.fallbackCount + 1,
  };
}

function contextOwnershipErrorMessage(reason: ContextFallbackReason): string {
  switch (reason) {
    case "host-cannot-replace-context": return "managed-context requires host context replacement";
    case "host-cannot-replace-compaction": return "managed-context requires host compaction replacement";
    case "managed-runtime-unavailable": return "managed-context runtime dependencies are unavailable";
    case "projection-failed": return "managed-context projection failed";
    case "compact-failed": return "managed-context compaction failed";
    case "context-invalid": return "managed-context projection is invalid";
  }
}
