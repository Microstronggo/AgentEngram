import { registerAdapterFlags, resolveMode } from "./config.js";
import { createErrorReporter } from "./fail-open.js";
import { registerCompactionHooks } from "./hooks/compaction.js";
import { registerContextHook } from "./hooks/context.js";
import { registerSessionHooks } from "./hooks/session.js";
import { registerToolHooks } from "./hooks/tool.js";
import { registerTreeHooks } from "./hooks/tree.js";
import type { PiExtensionApi } from "./pi-types.js";
import type { AdapterOptions, EngineFacade } from "./types.js";
import { createLocalRuntimeEngineFacade } from "./runtime-engine-facade.js";
import { RecoveryRegistry } from "./recovery.js";
import { registerMemoryTools } from "./memory-tools.js";
import { registerModelHooks } from "./hooks/model.js";
import { loadAgentEngramConfigSync } from "@agentengram/engine/public";

export function createPiExtension(options: Partial<AdapterOptions> = {}) {
  const installed = loadAgentEngramConfigSync();
  const configuredMode = installed.config.adapters?.pi?.mode ?? installed.config.context?.defaultMode;
  const mode = options.mode ?? configuredMode ?? "auto";
  const configuredIdentity = installed.config.identities;
  const configuredHome = installed.sources.length > 0 || process.env.AGENTENGRAM_HOME
    ? installed.config.dataDir
    : undefined;
  const compactPolicy = installed.config.adapters?.pi?.models?.compact ?? installed.config.models?.compact;
  const formationPolicy = installed.config.adapters?.pi?.models?.formation ?? installed.config.models?.formation;
  if (!options.engine && mode === "managed-context" && compactPolicy?.strategy === "disabled") {
    throw new Error("Pi managed-context requires an enabled compact model strategy");
  }
  const usesHostCurrent = compactPolicy?.strategy === "host-current" || formationPolicy?.strategy === "host-current"
    || (compactPolicy?.strategy === undefined && formationPolicy?.strategy === undefined);
  const usesConfiguredProvider = compactPolicy?.strategy === "configured-provider"
    || compactPolicy?.fallback === "configured-provider"
    || formationPolicy?.strategy === "configured-provider"
    || formationPolicy?.fallback === "configured-provider"
    || (compactPolicy === undefined && formationPolicy === undefined);
  const engine = options.engine ?? createLocalRuntimeEngineFacade({
    ...(configuredHome === undefined ? {} : { homeDir: configuredHome }),
    ...(options.namespaceId === undefined ? {} : { namespaceId: options.namespaceId }),
    ...(installed.config.provider === undefined ? {} : { providerConfig: installed.config.provider }),
    useHostCurrentModel: usesHostCurrent,
    useConfiguredProvider: usesConfiguredProvider,
    formationMode: formationPolicy?.strategy === "disabled" ? "disabled" : "cell",
    contextMode: mode === "managed-context" ? "managed-context" : "enhance",
    ...(installed.config.context?.failOpen === undefined ? {} : { failOpen: installed.config.context.failOpen }),
  });
  const managedContextAvailable = engine.managedContextReady ?? Boolean(
    engine.buildManagedContext && engine.compact && engine.createCheckpoint &&
    engine.restoreCheckpoint && engine.rebuildFromCanonical,
  );
  const report = createErrorReporter(options.notifyOnError ?? true);
  const recovery = new RecoveryRegistry();

  return function agentEngramPiExtension(pi: PiExtensionApi): void {
    registerAdapterFlags(pi, mode);
    // Validate explicit CLI/config ownership before any hooks are installed.
    // Runtime hook failures may fail open, but a mode contract must not.
    resolveMode(pi, mode, managedContextAvailable);
    registerSessionHooks(pi, engine, recovery, report);
    registerModelHooks(pi, engine, report);
    registerContextHook(pi, engine, mode, managedContextAvailable, recovery, report, options.managedFailurePolicy);
    registerToolHooks(pi, engine, report);
    registerCompactionHooks(pi, engine, mode, managedContextAvailable, report, options.managedFailurePolicy);
    registerTreeHooks(pi, engine, recovery, report);
    registerMemoryTools(pi, options.memoryApplication ?? engine.memoryApplication, report, options.scopeIdentity ?? configuredIdentity);
  };
}

/** Installable Pi entrypoint backed by AgentEngramRuntime. */
export default createPiExtension();
