import { appendCheckpoint } from "../checkpoint.js";
import { resolvePiOwnership } from "../config.js";
import { mapPiEvent } from "../event-mapper.js";
import { failOpen, type ErrorReporter } from "../fail-open.js";
import type { PiExtensionApi } from "../pi-types.js";
import type { EngineFacade, IntegrationMode } from "../types.js";
import { canonicalBranchMessages } from "../canonical-branch.js";
import { piIdentity } from "../event-mapper.js";
import { mirrorActiveBranchTranscript, mirrorProvidedBranchTranscript } from "./transcript.js";
import type { ManagedFailurePolicy } from "@agentengram/engine/public";

export function registerCompactionHooks(
  pi: PiExtensionApi,
  engine: EngineFacade,
  defaultMode: IntegrationMode,
  managedContextAvailable: boolean,
  report: ErrorReporter,
  failurePolicy: ManagedFailurePolicy = "host-fallback",
): void {
  pi.on("session_before_compact", async (event, context) => {
    const compact = async () => {
      engine.observeHostContext?.(context);
      await engine.handleEvent?.(mapPiEvent("session_before_compact", event, context));
      await mirrorProvidedBranchTranscript(engine, context, Array.isArray(event.branchEntries) ? event.branchEntries : [], "session_before_compact", report);
      const sessionFile = context.sessionManager.getSessionFile();
      const identity = piIdentity(context);
      const canonicalMessages = canonicalBranchMessages(context.sessionManager.getBranch?.());
      const checkpointContext = {
        cwd: context.cwd,
        ...identity,
        ...(canonicalMessages.length === 0 ? {} : { canonicalMessages }),
        payload: event,
        ...(sessionFile === undefined ? {} : { sessionFile }),
      };
      // A checkpoint write failure must not suppress either AgentEngram or Pi compaction.
      await failOpen("pre-compact checkpoint", context, report, async () => {
        const checkpoint = await engine.createCheckpoint?.("pre_compact", checkpointContext);
        if (checkpoint) appendCheckpoint(pi, checkpoint);
      });

      const ownership = resolvePiOwnership(pi, defaultMode, managedContextAvailable, failurePolicy);
      if (ownership.effectiveMode !== "managed-context") return undefined;
      if (event.signal?.aborted) return undefined;

      const request = {
        mode: "managed-context" as const,
        preparation: event.preparation,
        branchEntries: event.branchEntries,
        signal: event.signal,
        cwd: context.cwd,
        ...identity,
        canonicalMessages,
        ...(event.customInstructions === undefined ? {} : { customInstructions: event.customInstructions }),
        ...(sessionFile === undefined ? {} : { sessionFile }),
        ...(context.model === undefined ? {} : { model: context.model }),
      };
      try {
        const compaction = await engine.compact?.(request);
        if (isValidManagedCompaction(compaction, event.branchEntries)) return { compaction };
        await engine.recordOwnershipFallback?.({ cwd: context.cwd, ...identity, reason: "compact-failed", ownership });
        report(new Error("AgentEngram returned an invalid managed compaction"), "pre-compact", context);
        return undefined;
      } catch (error) {
        await engine.recordOwnershipFallback?.({ cwd: context.cwd, ...identity, reason: "compact-failed", ownership });
        if (failurePolicy === "strict") throw error;
        report(error, "pre-compact", context);
        return undefined;
      }
    };
    return failurePolicy === "strict"
      ? compact()
      : failOpen("pre-compact", context, report, compact);
  });

  pi.on("session_compact", async (event, context) => {
    await failOpen("post-compact", context, report, async () => {
      engine.observeHostContext?.(context);
      await engine.handleEvent?.(mapPiEvent("session_compact", event, context));
      await mirrorActiveBranchTranscript(engine, context, "session_compact", report);
      const sessionFile = context.sessionManager.getSessionFile();
      const identity = piIdentity(context);
      const canonicalMessages = canonicalBranchMessages(context.sessionManager.getBranch?.());
      const checkpoint = await engine.createCheckpoint?.("post_compact", {
        cwd: context.cwd,
        ...identity,
        ...(canonicalMessages.length === 0 ? {} : { canonicalMessages }),
        payload: event,
        ...(sessionFile === undefined ? {} : { sessionFile }),
      });
      if (checkpoint) appendCheckpoint(pi, checkpoint);
    });
  });
}

function isValidManagedCompaction(value: unknown, branchEntries: unknown): value is {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
} {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.summary !== "string" || candidate.summary.trim() === "" ||
    typeof candidate.firstKeptEntryId !== "string" ||
    typeof candidate.tokensBefore !== "number" || !Number.isFinite(candidate.tokensBefore) ||
    candidate.tokensBefore < 0
  ) return false;
  if (!Array.isArray(branchEntries)) return false;
  return branchEntries.some((entry) =>
    entry !== null && typeof entry === "object" &&
    (entry as { id?: unknown }).id === candidate.firstKeptEntryId
  );
}
