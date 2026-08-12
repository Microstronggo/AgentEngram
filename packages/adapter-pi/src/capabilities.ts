import type { HostCapabilities } from "@agentengram/engine/adapter";

/**
 * Pi host guarantees used by Engine ownership negotiation and adapter
 * conformance tests. Keep this declaration aligned with the hooks registered
 * by `createPiExtension`; a capability is true only when Pi exposes a usable
 * replacement or lifecycle surface.
 */
export const PI_HOST_CAPABILITIES: HostCapabilities = Object.freeze({
  contextHook: true,
  replaceContext: true,
  compactionHook: true,
  replaceCompaction: true,
  sessionLifecycle: true,
  threadLifecycle: true,
  toolLifecycle: true,
  persistentCustomEntries: true,
  transcriptMode: "branch",
  canInvokeCurrentModel: true,
  runtimeLifetime: "long-lived",
  supportsSubagents: false,
  schemaVersion: "pi-extension-v1",
});
