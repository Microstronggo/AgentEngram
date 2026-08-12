import type { AgentMessage, MessageContent } from "../../protocol/message.js";

/** Provider-independent token estimate used for deterministic budgeting. */
export type TokenEstimator = (value: unknown) => number;

/** Conservative, provider-independent fallback. Adapters may inject a tokenizer. */
export const roughTokenEstimate: TokenEstimator = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.ceil(text.length / 3);
};

/** Estimates one normalized message content segment. */
export function contentTokens(content: MessageContent, estimate: TokenEstimator = roughTokenEstimate): number {
  switch (content.type) {
    case "text":
      return estimate(content.text);
    case "tool-call":
      return estimate(content.name) + estimate(content.arguments);
    case "tool-result":
      return estimate(content.output);
  }
}

/** Estimates message content plus a small per-message framing overhead. */
export function messageTokens(
  message: AgentMessage,
  estimate: TokenEstimator = roughTokenEstimate,
): number {
  return message.content.reduce((total, content) => total + contentTokens(content, estimate), 0);
}

/** Sums token estimates for an ordered normalized transcript. */
export function transcriptTokens(
  messages: readonly AgentMessage[],
  estimate: TokenEstimator = roughTokenEstimate,
): number {
  return messages.reduce((total, message) => total + messageTokens(message, estimate), 0);
}
