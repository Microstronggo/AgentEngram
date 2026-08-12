import type { ContextMode, ContextRequest, ContextView } from "../protocol/index.js";
import type { ContextProjector } from "./context-projector.js";
import { ContextValidationError, validateProjectedMessages } from "./message-validator.js";
import { allocateContextBudget, estimateMessageTokens } from "./token-budget.js";
import { fallbackContextOwnership } from "./context-ownership.js";

/** Ordered stages and fail-open policy for model-context construction. */
export interface ContextPipelineOptions {
  readonly mode?: ContextMode;
  readonly failOpen?: boolean;
  readonly projectors?: readonly ContextProjector[];
}

/** Applies ordered projections, validates invariants, and enforces the final token budget. */
export class ContextPipeline {
  /** Integration mode used when a request does not override it. */
  readonly defaultMode: ContextMode;
  /** Whether projection failures return the framework context instead of aborting the host. */
  readonly failOpen: boolean;
  /** Ordered, framework-neutral context transformations. */
  readonly projectors: readonly ContextProjector[];

  constructor(options: ContextPipelineOptions = {}) {
    this.defaultMode = options.mode ?? "enhance";
    this.failOpen = options.failOpen ?? true;
    this.projectors = options.projectors ?? [];
  }

  async build(request: ContextRequest): Promise<ContextView> {
    const mode = request.mode ?? this.defaultMode;
    const sourceMessages = mode === "managed-context"
      ? request.canonicalMessages
      : request.frameworkMessages;

    try {
      if (mode === "managed-context" && !request.capabilities.replaceContext) {
        throw new Error("Framework does not support replacing the model context");
      }

      let messages = sourceMessages;
      const inputTokens = tokenCount(messages);
      const stages = [];
      // Projection order is part of the runtime contract; later stages see earlier output.
      for (const current of this.projectors) {
        if (current.modes && !current.modes.includes(mode)) continue;
        const beforeTokens = tokenCount(messages);
        const startedAt = performance.now();
        messages = await current.project({ request, mode, messages });
        stages.push({
          stage: current.name ?? "anonymous-projector",
          beforeTokens,
          afterTokens: tokenCount(messages),
          durationMs: performance.now() - startedAt,
        });
      }
      validateProjectedMessages(messages);
      const allocation = request.contextWindow
        ? allocateContextBudget(messages, {
            contextWindow: request.contextWindow,
            ...(request.reservedOutputTokens === undefined ? {} : { reservedOutputTokens: request.reservedOutputTokens }),
          })
        : undefined;
      messages = allocation?.messages ?? messages;
      validateProjectedMessages(messages);

      return {
        requestId: request.requestId,
        mode,
        messages,
        source: this.projectors.length === 0 && mode === "enhance" ? "framework" : "agentengram",
        diagnostics: {
          inputTokens,
          outputTokens: tokenCount(messages),
          ...(allocation === undefined ? {} : {
            limitTokens: allocation.limitTokens,
            removedMessageIds: allocation.removedMessageIds,
          }),
          stages,
          ...(request.ownership === undefined ? {} : { ownership: request.ownership }),
        },
      };
    } catch (error) {
      if (!this.failOpen) throw error;
      // Managed failures transfer ownership back to the host only when the
      // negotiated policy permits it. Strict ownership intentionally escapes.
      const fallbackOwnership = request.ownership?.effectiveMode === "managed-context"
        ? fallbackContextOwnership(
            request.ownership,
            error instanceof ContextValidationError ? "context-invalid" : "projection-failed",
          )
        : request.ownership;
      return {
        requestId: request.requestId,
        mode,
        messages: request.frameworkMessages,
        source: "fail-open",
        failure: serializeError(error),
        diagnostics: {
          inputTokens: tokenCount(sourceMessages),
          outputTokens: tokenCount(request.frameworkMessages),
          stages: [],
          ...(fallbackOwnership === undefined ? {} : { ownership: fallbackOwnership }),
        },
      };
    }
  }
}

function tokenCount(messages: readonly import("../protocol/index.js").AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "UnknownError", message: String(error) };
}
