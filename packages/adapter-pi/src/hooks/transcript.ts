import { piIdentity } from "../event-mapper.js";
import { failOpen, type ErrorReporter } from "../fail-open.js";
import type { PiContext } from "../pi-types.js";
import type { EngineFacade, TranscriptMirrorRequest } from "../types.js";
import { resolveEnginePiHostBinding } from "../host-binding.js";

/** Mirrors Pi's active branch into AgentEngram's portable transcript store. */
export async function mirrorActiveBranchTranscript(
  engine: EngineFacade,
  context: PiContext,
  reason: TranscriptMirrorRequest["reason"],
  report: ErrorReporter,
): Promise<void> {
  if (!engine.recordTranscript) return;
  const branchEntries = context.sessionManager.getBranch?.() ?? [];
  if (branchEntries.length === 0) return;
  await failOpen(`transcript mirror:${reason}`, context, report, async () => {
    const sessionFile = context.sessionManager.getSessionFile();
    const identity = piIdentity(context);
    const binding = await resolveEnginePiHostBinding(engine, { cwd: context.cwd, ...identity });
    await engine.recordTranscript?.({
      cwd: context.cwd,
      ...identity,
      branchEntries,
      reason,
      hostBinding: binding,
      ...(sessionFile === undefined ? {} : { sessionFile }),
    });
  });
}

/** Mirrors a Pi-provided branch snapshot, used before compact when Pi passes the candidate entries directly. */
export async function mirrorProvidedBranchTranscript(
  engine: EngineFacade,
  context: PiContext,
  branchEntries: readonly unknown[],
  reason: TranscriptMirrorRequest["reason"],
  report: ErrorReporter,
): Promise<void> {
  if (!engine.recordTranscript || branchEntries.length === 0) return;
  await failOpen(`transcript mirror:${reason}`, context, report, async () => {
    const sessionFile = context.sessionManager.getSessionFile();
    const identity = piIdentity(context);
    const binding = await resolveEnginePiHostBinding(engine, { cwd: context.cwd, ...identity });
    await engine.recordTranscript?.({
      cwd: context.cwd,
      ...identity,
      branchEntries,
      reason,
      hostBinding: binding,
      ...(sessionFile === undefined ? {} : { sessionFile }),
    });
  });
}
