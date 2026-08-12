import type { AdapterCompatibilityDescriptor } from "@agentengram/engine/adapter";
import { CODEX_CAPABILITIES } from "./capabilities.js";

/** Reproducible Codex Hook evidence; unsupported managed ownership is not advertised. */
export const CODEX_ADAPTER_COMPATIBILITY: AdapterCompatibilityDescriptor = Object.freeze({
  schemaVersion: 1,
  adapterName: "@agentengram/adapter-codex",
  adapterContractVersion: 1,
  hostName: "OpenAI Codex CLI",
  integrationSchema: CODEX_CAPABILITIES.schemaVersion!,
  testedHostVersions: ["0.142.3"],
  support: "experimental",
});
