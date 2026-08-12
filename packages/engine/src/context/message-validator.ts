import type { AgentMessage } from "../protocol/index.js";

/** Identifies a structurally unsafe model-context projection. */
export class ContextValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ContextValidationError";
  }
}

/** Rejects structurally invalid model context before an adapter can deliver it. */
export function validateProjectedMessages(messages: readonly AgentMessage[]): void {
  const pendingToolCalls = new Set<string>();

  for (const message of messages) {
    for (const content of message.content) {
      if (content.type === "tool-call") {
        if (message.role !== "assistant") throw new ContextValidationError("tool-call content must belong to an assistant message");
        if (pendingToolCalls.has(content.id)) throw new ContextValidationError(`duplicate tool call id: ${content.id}`);
        pendingToolCalls.add(content.id);
      }
      if (content.type === "tool-result") {
        if (message.role !== "tool") throw new ContextValidationError("tool-result content must belong to a tool message");
        if (!pendingToolCalls.delete(content.toolCallId)) {
          throw new ContextValidationError(`orphan tool result: ${content.toolCallId}`);
        }
      }
    }
  }

  if (pendingToolCalls.size > 0) {
    throw new ContextValidationError(`tool calls without results: ${[...pendingToolCalls].join(", ")}`);
  }
}
