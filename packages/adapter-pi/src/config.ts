import type { PiExtensionApi } from "./pi-types.js";
import type { IntegrationMode, ResolvedIntegrationMode } from "./types.js";
import {
  resolveContextOwnership,
  type ContextOwnershipDiagnostic,
  type ManagedFailurePolicy,
} from "@agentengram/engine/public";
import { PI_HOST_CAPABILITIES } from "./capabilities.js";

export const MODE_FLAG = "agentengram-mode";

export function registerAdapterFlags(pi: PiExtensionApi, defaultMode: IntegrationMode): void {
  pi.registerFlag?.(MODE_FLAG, {
    description: "AgentEngram integration mode: auto, enhance, or managed-context",
    type: "string",
    default: defaultMode,
  });
}

export function resolveMode(
  pi: PiExtensionApi,
  fallback: IntegrationMode,
  managedContextAvailable = true,
): ResolvedIntegrationMode {
  const value = pi.getFlag?.(MODE_FLAG);
  const requested = value === "auto" || value === "managed-context" || value === "enhance" ? value : fallback;
  // Auto is intentionally conservative. Hook availability alone does not mean
  // the host has transferred context ownership to AgentEngram.
  if (requested === "auto") return "enhance";
  if (requested === "managed-context" && !managedContextAvailable) {
    throw new Error("managed-context requires context replacement, compaction, checkpoint, and recovery capabilities");
  }
  return requested;
}

/** Returns the validated ownership decision used by context and compact hooks. */
export function resolvePiOwnership(
  pi: PiExtensionApi,
  fallback: IntegrationMode,
  managedContextAvailable: boolean,
  failurePolicy: ManagedFailurePolicy = "host-fallback",
): ContextOwnershipDiagnostic {
  const value = pi.getFlag?.(MODE_FLAG);
  const requestedMode = value === "auto" || value === "managed-context" || value === "enhance"
    ? value
    : fallback;
  return resolveContextOwnership({
    requestedMode,
    capabilities: PI_HOST_CAPABILITIES,
    managedRuntimeReady: managedContextAvailable,
    failurePolicy,
  });
}
