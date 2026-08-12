import { resolvePiOwnership } from "../config.js";
import { failOpen, type ErrorReporter } from "../fail-open.js";
import type { PiExtensionApi } from "../pi-types.js";
import type { EngineFacade, IntegrationMode } from "../types.js";
import type { ManagedFailurePolicy } from "@agentengram/engine/public";
import { piIdentity } from "../event-mapper.js";
import { canonicalBranchMessages } from "../canonical-branch.js";
import type { RecoveryRegistry } from "../recovery.js";
import { mirrorActiveBranchTranscript } from "./transcript.js";
import { resolveEnginePiHostBinding } from "../host-binding.js";

export function registerContextHook(
  pi: PiExtensionApi,
  engine: EngineFacade,
  defaultMode: IntegrationMode,
  managedContextAvailable: boolean,
  recovery: RecoveryRegistry,
  report: ErrorReporter,
  failurePolicy: ManagedFailurePolicy = "host-fallback",
): void {
  pi.on("context", async (event, context) => {
    const project = async () => {
      engine.observeHostContext?.(context);
      const ownership = resolvePiOwnership(pi, defaultMode, managedContextAvailable, failurePolicy);
      const mode = ownership.effectiveMode;
      await mirrorActiveBranchTranscript(engine, context, "context", report);
      const sessionFile = context.sessionManager.getSessionFile();
      const identity = piIdentity(context);
      const contextUsage = context.getContextUsage?.();
      const canonicalMessages = canonicalBranchMessages(context.sessionManager.getBranch?.());
      const recoveryMessages = recovery.get(identity.sessionId, identity.threadId);
      const binding = await resolveEnginePiHostBinding(engine, { cwd: context.cwd, ...identity });
      const request = {
        mode,
        messages: event.messages,
        ...(canonicalMessages.length > 0 ? { canonicalMessages } : {}),
        ...(recoveryMessages === undefined ? {} : { recoveryMessages }),
        cwd: context.cwd,
        ...identity,
        ...(sessionFile === undefined ? {} : { sessionFile }),
        ...(context.model === undefined ? {} : { model: context.model }),
        ...(contextUsage === undefined ? {} : { contextWindow: contextUsage.contextWindow }),
        hostBinding: binding,
        ownership,
      };
      const projected = engine.projectContextView
        ? await engine.projectContextView(request)
        : undefined;
      const messages = projected?.messages ?? (
        mode === "managed-context"
          ? await engine.buildManagedContext?.(request)
          : await engine.enhanceContext?.(request)
      );

      if (projected?.failure) {
        // Engine may serialize a projection failure when its pipeline is
        // generally fail-open. Strict adapter ownership must still surface it
        // instead of returning a host fallback as if managed projection won.
        if (failurePolicy === "strict") throw new Error(projected.failure.message);
        report(new Error(projected.failure.message), "context projection", context);
      }

      // Returning undefined tells Pi to preserve the context produced by earlier handlers.
      return messages ? { messages } : undefined;
    };
    return failurePolicy === "strict"
      ? project()
      : failOpen("context projection", context, report, project);
  });
}
