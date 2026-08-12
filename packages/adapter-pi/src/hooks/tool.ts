import { mapPiEvent } from "../event-mapper.js";
import { failOpen, type ErrorReporter } from "../fail-open.js";
import type { PiExtensionApi } from "../pi-types.js";
import type { EngineFacade } from "../types.js";

export function registerToolHooks(pi: PiExtensionApi, engine: EngineFacade, report: ErrorReporter): void {
  for (const eventName of ["tool_call", "tool_result"] as const) {
    pi.on(eventName, async (event, context) => {
      await failOpen(eventName, context, report, () => engine.handleEvent?.(mapPiEvent(eventName, event, context)));
      // Tool interception happens before Pi has necessarily published the
      // corresponding durable branch entry. Transcript reconciliation runs at
      // turn/context/lifecycle hooks where SessionManager is authoritative.
      return undefined;
    });
  }
}
