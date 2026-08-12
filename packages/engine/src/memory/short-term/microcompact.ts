import type { AgentMessage, ToolResultContent } from "../../protocol/message.js";

/** Stable placeholder retained after a provider-safe tool result clear. */
export const CLEARED_TOOL_RESULT = "[Old tool result content cleared]";

/** Provider contract for cache-aware tool-result removal. */
export interface ProviderCacheEditCapability {
  readonly supported: boolean;
  deleteToolResults(toolCallIds: readonly string[]): Promise<unknown>;
}

/** Replayable decision describing which tool results were cleared. */
export interface MicrocompactDecision {
  readonly kind: "microcompact";
  readonly strategy: "time-based" | "provider-cache-edit";
  readonly clearedToolCallIds: readonly string[];
  readonly boundaryAt: string;
  readonly providerEdit?: unknown;
  readonly algorithmVersion: string;
  readonly configVersion: string;
}

/** Thresholds and provider integration for one Microcompact pass. */
export interface MicrocompactOptions {
  readonly now: Date;
  readonly coldAfterMs: number;
  readonly keepRecentToolResults: number;
  readonly compactableToolNames?: ReadonlySet<string>;
  readonly providerCacheEdit?: ProviderCacheEditCapability;
  readonly preferProviderCacheEdit?: boolean;
  readonly algorithmVersion?: string;
  readonly configVersion?: string;
}

/** Clears eligible cold tool results or delegates deletion to a provider cache-edit API. */
export async function microcompact(
  messages: readonly AgentMessage[],
  options: MicrocompactOptions,
): Promise<{ readonly messages: readonly AgentMessage[]; readonly decision?: MicrocompactDecision }> {
  const toolNames = toolNamesByCallId(messages);
  const results = collectResults(messages).filter(({ result }) => {
    const allowed = options.compactableToolNames;
    return !allowed || allowed.has(toolNames.get(result.toolCallId) ?? "");
  });
  const deleteCount = Math.max(0, results.length - Math.max(0, options.keepRecentToolResults));
  if (deleteCount === 0) return { messages };
  const ids = results.slice(0, deleteCount).map(({ result }) => result.toolCallId);
  const lastAssistantAt = [...messages].reverse().find((message) => message.role === "assistant")?.createdAt;
  const isCold = lastAssistantAt !== undefined &&
    options.now.getTime() - new Date(lastAssistantAt).getTime() >= options.coldAfterMs;

  let strategy: MicrocompactDecision["strategy"];
  let providerEdit: unknown;
  if (!isCold && options.preferProviderCacheEdit && options.providerCacheEdit?.supported) {
    strategy = "provider-cache-edit";
    providerEdit = await options.providerCacheEdit.deleteToolResults(ids);
  } else if (isCold) {
    strategy = "time-based";
  } else {
    return { messages };
  }
  const decision: MicrocompactDecision = {
    kind: "microcompact",
    strategy,
    clearedToolCallIds: ids,
    boundaryAt: options.now.toISOString(),
    providerEdit,
    algorithmVersion: options.algorithmVersion ?? "microcompact-v1",
    configVersion: options.configVersion ?? "v1",
  };
  if (strategy === "provider-cache-edit") return { messages, decision };
  const cleared = new Set(ids);
  return {
    messages: messages.map((message) => ({
      ...message,
      content: message.content.map((content) =>
        content.type === "tool-result" && cleared.has(content.toolCallId)
          ? { ...content, output: CLEARED_TOOL_RESULT }
          : content,
      ),
    })),
    decision,
  };
}

function collectResults(messages: readonly AgentMessage[]): { message: AgentMessage; result: ToolResultContent }[] {
  return messages.flatMap((message) => message.content.flatMap((content) =>
    content.type === "tool-result" ? [{ message, result: content }] : [],
  ));
}

function toolNamesByCallId(messages: readonly AgentMessage[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const message of messages) for (const content of message.content) {
    if (content.type === "tool-call") result.set(content.id, content.name);
  }
  return result;
}
