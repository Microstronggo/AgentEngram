import type { AdapterCompatibilityDescriptor } from "@agentengram/engine/adapter";
import { PI_HOST_CAPABILITIES } from "./capabilities.js";

/** Reproducible Pi compatibility evidence; broad semver support is not inferred from one test. */
export const PI_ADAPTER_COMPATIBILITY: AdapterCompatibilityDescriptor = Object.freeze({
  schemaVersion: 1,
  adapterName: "@agentengram/adapter-pi",
  adapterContractVersion: 1,
  hostName: "pi-mono",
  integrationSchema: PI_HOST_CAPABILITIES.schemaVersion!,
  testedHostVersions: ["@earendil-works/pi-ai@0.80.7"],
  support: "experimental",
});
