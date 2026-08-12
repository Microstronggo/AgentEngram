import { appendCheckpoint } from "../checkpoint.js";
import { mapPiEvent, piIdentity, resetPiThreadIdentity } from "../event-mapper.js";
import { failOpen, type ErrorReporter } from "../fail-open.js";
import type { PiExtensionApi } from "../pi-types.js";
import type { EngineFacade } from "../types.js";
import { recoverActiveBranch, type RecoveryRegistry } from "../recovery.js";
import { canonicalBranchMessages } from "../canonical-branch.js";
import { mirrorActiveBranchTranscript } from "./transcript.js";

export function registerSessionHooks(
  pi: PiExtensionApi,
  engine: EngineFacade,
  recovery: RecoveryRegistry,
  report: ErrorReporter,
): void {
  for (const eventName of ["before_agent_start", "turn_end", "agent_end"] as const) {
    pi.on(eventName, async (event, context) => {
      engine.observeHostContext?.(context);
      if (eventName === "turn_end" || eventName === "agent_end") {
        // Transcript durability precedes formation scheduling. Otherwise the
        // runtime can consume the lifecycle event before this turn is visible.
        await mirrorActiveBranchTranscript(engine, context, eventName, report);
      }
      await failOpen(eventName, context, report, () => engine.handleEvent?.(mapPiEvent(eventName, event, context)));
    });
  }

  pi.on("session_start", async (event, context) => {
    engine.observeHostContext?.(context);
    resetPiThreadIdentity(context);
    await failOpen("session_start", context, report, () =>
      engine.handleEvent?.(mapPiEvent("session_start", event, context)),
    );
    await failOpen("checkpoint recovery", context, report, () =>
      recoverActiveBranch(context, engine, recovery, "session_start", (error) =>
        report(error, "checkpoint restore; rebuilding canonical transcript", context)),
    );
  });

  pi.on("session_shutdown", async (event, context) => {
    engine.observeHostContext?.(context);
    await failOpen("session_shutdown", context, report, async () => {
      // recordTranscript performs the final Cell-tail flush before checkpointing.
      await mirrorActiveBranchTranscript(engine, context, "session_shutdown", report);
      await engine.handleEvent?.(mapPiEvent("session_shutdown", event, context));
      const sessionFile = context.sessionManager.getSessionFile();
      const canonicalMessages = canonicalBranchMessages(context.sessionManager.getBranch?.());
      const checkpoint = await engine.createCheckpoint?.("shutdown", {
        cwd: context.cwd,
        ...piIdentity(context),
        ...(canonicalMessages.length === 0 ? {} : { canonicalMessages }),
        payload: event,
        ...(sessionFile === undefined ? {} : { sessionFile }),
      });
      if (checkpoint) appendCheckpoint(pi, checkpoint);
    });
  });
}
