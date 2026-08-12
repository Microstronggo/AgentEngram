export type PiEventName =
  | "session_start"
  | "session_shutdown"
  | "before_agent_start"
  | "agent_end"
  | "turn_end"
  | "context"
  | "tool_call"
  | "tool_result"
  | "session_before_compact"
  | "session_compact"
  | "session_before_tree"
  | "session_tree"
  | "model_select";

/** Minimal current-model shape consumed by the provider-generic Pi bridge. */
export interface PiModel {
  readonly id: string;
  readonly name?: string;
  readonly api: string;
  readonly provider: string;
  readonly baseUrl?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly [key: string]: unknown;
}

/** Auth result returned by Pi without persisting any provider credential. */
export type PiResolvedRequestAuth =
  | {
      readonly ok: true;
      readonly apiKey?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly env?: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly error: string };

/** Structural subset of Pi's ModelRegistry needed for current-model calls. */
export interface PiModelRegistry {
  getApiKeyAndHeaders(model: PiModel): Promise<PiResolvedRequestAuth>;
}

export interface PiSessionManager {
  getSessionFile(): string | undefined;
  getSessionId?(): string;
  getLeafId?(): string | null;
  getBranch?(): unknown[];
}

export interface PiContext {
  cwd: string;
  sessionManager: PiSessionManager;
  model?: PiModel;
  /** Registry resolves the current model's provider-specific auth at call time. */
  modelRegistry?: PiModelRegistry;
  /** Pi's live token estimate and active model context capacity. */
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  ui?: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export type PiHandler = (event: any, context: PiContext) => unknown | Promise<unknown>;

export type PiJsonSchema = TSchema;

export interface PiToolResult<TDetails = unknown> {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: TDetails;
}

/** Structural subset of pi-mono's ToolDefinition used by native memory tools. */
export interface PiToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: PiJsonSchema;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: PiContext,
  ): Promise<PiToolResult>;
}

/** Structural subset of pi-mono's ExtensionAPI used by this adapter. */
export interface PiExtensionApi {
  on(event: PiEventName, handler: PiHandler): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;
  registerTool?(tool: PiToolDefinition): void;
  registerFlag?(
    name: string,
    options: { description: string; type: "string"; default: string },
  ): void;
  getFlag?(name: string): boolean | string | undefined;
}
import type { TSchema } from "typebox";
