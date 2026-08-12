import { failOpen, type ErrorReporter } from "../fail-open.js";
import type { PiExtensionApi } from "../pi-types.js";
import type { EngineFacade } from "../types.js";

/** Tracks Pi model selection so subsequent Compact/Formation calls use it. */
export function registerModelHooks(
  pi: PiExtensionApi,
  engine: EngineFacade,
  report: ErrorReporter,
): void {
  pi.on("model_select", async (_event, context) => {
    await failOpen("model selection", context, report, () => {
      engine.observeHostContext?.(context);
    });
  });
}
