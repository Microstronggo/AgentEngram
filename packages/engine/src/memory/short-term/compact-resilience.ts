import type { AgentMessage } from "../../protocol/message.js";
import type { CompactSummarizer, CompactSummary } from "./compact.js";
import type { SessionMemory } from "./session-memory.js";

/** Persistent circuit-breaker counters for automatic compaction failures. */
export interface CompactFailureState {
  readonly consecutiveFailures: number;
  readonly disabled: boolean;
}

/** Decision to retry, suppress, or fall back after a Compact failure. */
export interface CompactRetryDecision {
  readonly kind: "prompt-too-long-truncation" | "streaming-retry" | "circuit-open";
  readonly attempt: number;
  readonly droppedMessageIds?: readonly string[];
  readonly remainingMessageIds?: readonly string[];
}

/** Retry limits and fail-open fallback for model-backed compaction. */
export interface ResilientCompactOptions {
  readonly summarizer: CompactSummarizer;
  readonly messages: readonly AgentMessage[];
  readonly sessionMemory?: SessionMemory;
  readonly instructions: readonly string[];
  readonly apiRounds?: readonly (readonly AgentMessage[])[];
  readonly maxPromptTooLongRetries?: number;
  readonly maxStreamingRetries?: number;
  readonly isPromptTooLong?: (error: unknown) => boolean;
  readonly signal?: AbortSignal;
}

/** Prevents repeated summarizer failures from destabilizing live context builds. */
export class AutoCompactCircuitBreaker {
  private failures = 0;
  constructor(private readonly maxConsecutiveFailures = 3) {}

  get state(): CompactFailureState {
    return { consecutiveFailures: this.failures, disabled: this.failures >= this.maxConsecutiveFailures };
  }

  beforeAttempt(): CompactRetryDecision | undefined {
    return this.state.disabled ? { kind: "circuit-open", attempt: this.failures } : undefined;
  }

  recordSuccess(): CompactFailureState {
    this.failures = 0;
    return this.state;
  }

  recordFailure(): CompactFailureState {
    this.failures += 1;
    return this.state;
  }
}

export async function summarizeWithCompactRetries(
  options: ResilientCompactOptions,
): Promise<{ readonly summary: CompactSummary; readonly decisions: readonly CompactRetryDecision[] }> {
  const decisions: CompactRetryDecision[] = [];
  const isPromptTooLong = options.isPromptTooLong ?? defaultPromptTooLong;
  let rounds = options.apiRounds?.map((round) => [...round]) ?? groupByUserTurns(options.messages);
  let promptAttempts = 0;
  let streamingAttempts = 0;

  while (true) {
    try {
      const summary = await options.summarizer.summarize({
        messages: rounds.flat(),
        instructions: options.instructions,
        ...(options.sessionMemory === undefined ? {} : { sessionMemory: options.sessionMemory }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return { summary, decisions };
    } catch (error) {
      if (isPromptTooLong(error)) {
        promptAttempts += 1;
        if (promptAttempts > (options.maxPromptTooLongRetries ?? 3) || rounds.length <= 1) throw error;
        const dropped = rounds[0]!;
        rounds = rounds.slice(1);
        decisions.push({
          kind: "prompt-too-long-truncation",
          attempt: promptAttempts,
          droppedMessageIds: dropped.map((message) => message.id),
          remainingMessageIds: rounds.flat().map((message) => message.id),
        });
        continue;
      }

      streamingAttempts += 1;
      if (streamingAttempts > (options.maxStreamingRetries ?? 1)) throw error;
      decisions.push({ kind: "streaming-retry", attempt: streamingAttempts });
    }
  }
}

export async function summarizeWithCircuitBreaker(
  breaker: AutoCompactCircuitBreaker,
  options: ResilientCompactOptions,
): Promise<
  | { readonly status: "completed"; readonly summary: CompactSummary; readonly decisions: readonly CompactRetryDecision[] }
  | { readonly status: "skipped"; readonly reason: "circuit-open"; readonly decision: CompactRetryDecision }
> {
  const open = breaker.beforeAttempt();
  if (open) return { status: "skipped", reason: "circuit-open", decision: open };
  try {
    const result = await summarizeWithCompactRetries(options);
    breaker.recordSuccess();
    return { status: "completed", ...result };
  } catch (error) {
    breaker.recordFailure();
    throw error;
  }
}

function defaultPromptTooLong(error: unknown): boolean {
  return error instanceof Error && /prompt.*too.*long|context.*length|context.*overflow/i.test(error.message);
}

function groupByUserTurns(messages: readonly AgentMessage[]): readonly AgentMessage[][] {
  const groups: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };
  for (const message of messages) {
    if (message.role === "user" && current.length > 0) flush();
    current.push(message);
  }
  flush();
  return groups.length === 0 ? [messages.slice()] : groups;
}
