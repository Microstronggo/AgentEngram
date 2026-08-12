export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;

export type CodexHookEventName = (typeof CODEX_HOOK_EVENTS)[number];

/** Required property names copied from Codex's generated command input schemas. */
export const CODEX_HOOK_REQUIRED_FIELDS: Readonly<Record<CodexHookEventName, readonly string[]>> = Object.freeze({
  SessionStart: ["cwd", "hook_event_name", "model", "permission_mode", "session_id", "source", "transcript_path"],
  UserPromptSubmit: ["cwd", "hook_event_name", "model", "permission_mode", "prompt", "session_id", "transcript_path", "turn_id"],
  PreToolUse: ["cwd", "hook_event_name", "model", "permission_mode", "session_id", "tool_input", "tool_name", "tool_use_id", "transcript_path", "turn_id"],
  PermissionRequest: ["cwd", "hook_event_name", "model", "permission_mode", "session_id", "tool_input", "tool_name", "transcript_path", "turn_id"],
  PostToolUse: ["cwd", "hook_event_name", "model", "permission_mode", "session_id", "tool_input", "tool_name", "tool_response", "tool_use_id", "transcript_path", "turn_id"],
  PreCompact: ["cwd", "hook_event_name", "model", "session_id", "transcript_path", "trigger", "turn_id"],
  PostCompact: ["cwd", "hook_event_name", "model", "session_id", "transcript_path", "trigger", "turn_id"],
  SubagentStart: ["agent_id", "agent_type", "cwd", "hook_event_name", "model", "permission_mode", "session_id", "transcript_path", "turn_id"],
  SubagentStop: ["agent_id", "agent_transcript_path", "agent_type", "cwd", "hook_event_name", "last_assistant_message", "model", "permission_mode", "session_id", "stop_hook_active", "transcript_path", "turn_id"],
  Stop: ["cwd", "hook_event_name", "last_assistant_message", "model", "permission_mode", "session_id", "stop_hook_active", "transcript_path", "turn_id"],
});

/** Fields shared by Codex command-hook payloads before event-specific requirements. */
interface CodexHookInputBase {
  readonly session_id: string;
  readonly turn_id?: string;
  readonly agent_id?: string;
  readonly agent_type?: string;
  readonly agent_transcript_path?: string | null;
  readonly transcript_path: string | null;
  readonly cwd: string;
  readonly hook_event_name: CodexHookEventName;
  readonly model: string;
  readonly permission_mode?: string;
  readonly source?: string;
  readonly prompt?: string;
  readonly trigger?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
  readonly tool_use_id?: string;
  readonly last_assistant_message?: string | null;
  readonly stop_hook_active?: boolean;
}

/** Makes selected upstream schema fields required without duplicating the common payload. */
type RequiredHookFields<Keys extends keyof CodexHookInputBase> =
  CodexHookInputBase & Required<Pick<CodexHookInputBase, Keys>>;

/** Event-specific command-hook input union pinned to Codex's generated V1 schemas. */
export type CodexHookInput =
  | (RequiredHookFields<"permission_mode" | "source"> & { readonly hook_event_name: "SessionStart" })
  | (RequiredHookFields<"permission_mode" | "turn_id" | "prompt"> & { readonly hook_event_name: "UserPromptSubmit" })
  | (RequiredHookFields<"permission_mode" | "turn_id" | "tool_name" | "tool_input" | "tool_use_id"> & { readonly hook_event_name: "PreToolUse" })
  | (RequiredHookFields<"permission_mode" | "turn_id" | "tool_name" | "tool_input"> & { readonly hook_event_name: "PermissionRequest" })
  | (RequiredHookFields<"permission_mode" | "turn_id" | "tool_name" | "tool_input" | "tool_response" | "tool_use_id"> & { readonly hook_event_name: "PostToolUse" })
  // Compact hooks deliberately omit permission_mode: the upstream schemas do
  // not expose it for these lifecycle events.
  | (RequiredHookFields<"turn_id" | "trigger"> & { readonly hook_event_name: "PreCompact" | "PostCompact" })
  | (RequiredHookFields<"permission_mode" | "turn_id" | "agent_id" | "agent_type"> & { readonly hook_event_name: "SubagentStart" })
  | (RequiredHookFields<"permission_mode" | "turn_id" | "agent_id" | "agent_type" | "agent_transcript_path" | "last_assistant_message" | "stop_hook_active"> & { readonly hook_event_name: "SubagentStop" })
  | (RequiredHookFields<"permission_mode" | "turn_id" | "last_assistant_message" | "stop_hook_active"> & { readonly hook_event_name: "Stop" });

export interface CodexHookOutput {
  readonly continue?: boolean;
  readonly suppressOutput?: boolean;
  readonly systemMessage?: string;
  readonly hookSpecificOutput?: {
    readonly hookEventName: "SessionStart" | "UserPromptSubmit" | "SubagentStart";
    readonly additionalContext?: string;
  };
}
