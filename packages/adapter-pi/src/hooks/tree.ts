import { appendCheckpoint } from "../checkpoint.js";
import { mapPiEvent, piIdentity, updatePiTreeIdentity } from "../event-mapper.js";
import { failOpen, type ErrorReporter } from "../fail-open.js";
import type { PiExtensionApi } from "../pi-types.js";
import type { EngineFacade } from "../types.js";
import { recoverActiveBranch, type RecoveryRegistry } from "../recovery.js";
import { canonicalBranchMessages } from "../canonical-branch.js";
import { mirrorActiveBranchTranscript } from "./transcript.js";

export function registerTreeHooks(
  pi: PiExtensionApi,
  engine: EngineFacade,
  recovery: RecoveryRegistry,
  report: ErrorReporter,
): void {
  pi.on("session_before_tree", async (event, context) => {
    engine.observeHostContext?.(context);
    await failOpen("session_before_tree", context, report, async () => {
      // Flush the branch being left while its original thread identity and
      // active transcript are still available.
      await mirrorActiveBranchTranscript(engine, context, "session_before_tree", report);
      await engine.handleEvent?.(mapPiEvent("session_before_tree", event, context));
      const sessionFile = context.sessionManager.getSessionFile();
      const canonicalMessages = canonicalBranchMessages(context.sessionManager.getBranch?.());
      // Persist the branch being left before Pi moves its active leaf.
      const checkpoint = await engine.createCheckpoint?.("tree_change", {
        cwd: context.cwd,
        ...piIdentity(context),
        ...(canonicalMessages.length === 0 ? {} : { canonicalMessages }),
        payload: event,
        ...(sessionFile === undefined ? {} : { sessionFile }),
      });
      if (checkpoint) appendCheckpoint(pi, checkpoint);
    });
    return undefined;
  });

  pi.on("session_tree", async (event, context) => {
    engine.observeHostContext?.(context);
    updatePiTreeIdentity(context, event.newLeafId);
    await failOpen("session_tree", context, report, () =>
      engine.handleEvent?.(mapPiEvent("session_tree", event, context)),
    );
    await mirrorActiveBranchTranscript(engine, context, "session_tree", report);
    // Recover the target branch before writing any pointer that could shadow its last valid checkpoint.
    await failOpen("tree checkpoint recovery", context, report, () =>
      recoverActiveBranch(context, engine, recovery, "tree_change", (error) =>
        report(error, "tree checkpoint restore; rebuilding canonical transcript", context)),
    );
    await failOpen("tree checkpoint", context, report, async () => {
      const sessionFile = context.sessionManager.getSessionFile();
      const canonicalMessages = canonicalBranchMessages(context.sessionManager.getBranch?.());
      const checkpoint = await engine.createCheckpoint?.("tree_change", {
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
