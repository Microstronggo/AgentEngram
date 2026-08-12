/** Framework-neutral role vocabulary accepted by the context pipeline. */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** Plain text segment retained in a normalized Agent message. */
export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

/** Provider-neutral representation of an assistant tool invocation. */
export interface ToolCallContent {
  readonly type: "tool-call";
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Provider-neutral tool output linked to its invocation id. */
export interface ToolResultContent {
  readonly type: "tool-result";
  readonly toolCallId: string;
  readonly output: unknown;
  readonly isError?: boolean;
}

/** Content union transformed by short-term context policies. */
export type MessageContent = TextContent | ToolCallContent | ToolResultContent;

/** Framework-neutral message used by projection. Adapters own wire-format conversion. */
export interface AgentMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: readonly MessageContent[];
  readonly createdAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
