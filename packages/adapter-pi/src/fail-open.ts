import type { PiContext } from "./pi-types.js";

export type ErrorReporter = (error: unknown, operation: string, context: PiContext) => void;

export function createErrorReporter(notify: boolean): ErrorReporter {
  return (error, operation, context) => {
    if (!notify) return;
    const message = error instanceof Error ? error.message : String(error);
    context.ui?.notify(`AgentEngram ${operation} failed; using Pi defaults: ${message}`, "warning");
  };
}

export async function failOpen<T>(
  operation: string,
  context: PiContext,
  reporter: ErrorReporter,
  action: () => T | Promise<T>,
): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    reporter(error, operation, context);
    return undefined;
  }
}
