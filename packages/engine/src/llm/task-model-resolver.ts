import type { LLMChatClient } from "./llm-client.js";

/** Model-backed Runtime operations that may use independent model policies. */
export type ModelTask =
  | "compact"
  | "collapse"
  | "cell-boundary"
  | "memory-formation"
  | "memory-reflection"
  | "evaluation";

/** Provider source selected without hard-coding Qwen into Runtime policy. */
export type TaskModelSource = "host-current" | "configured-provider" | "disabled";

/** Host and request metadata available during task-specific model resolution. */
export interface ModelResolutionContext {
  readonly hostType?: string;
  readonly sessionId?: string;
  readonly threadId?: string;
  /** True only when the adapter can invoke the active model. */
  readonly canInvokeCurrentModel: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Provider-neutral model client plus safe, non-secret identity metadata. */
export interface TaskModelBinding {
  readonly client: LLMChatClient;
  readonly provider?: string;
  readonly model?: string;
}

/** Request supplied to host-current and configured model providers. */
export interface TaskModelProviderRequest {
  readonly task: ModelTask;
  readonly context: ModelResolutionContext;
}

/** Lazy source of one callable model binding. */
export interface TaskModelProvider {
  resolve(request: TaskModelProviderRequest): Promise<TaskModelBinding | undefined> | TaskModelBinding | undefined;
}

/** Selected binding with enough metadata to explain a provider fallback. */
export interface ResolvedTaskModel extends TaskModelBinding {
  readonly requestedSource: Exclude<TaskModelSource, "disabled">;
  readonly source: Exclude<TaskModelSource, "disabled">;
  readonly fallbackReason?: "host-current-unavailable";
}

/** Framework-neutral model policy consumed by Compact and Formation callers. */
export interface TaskModelResolver {
  resolve(task: ModelTask, context: ModelResolutionContext): Promise<ResolvedTaskModel | undefined>;
}

/** Configuration for the deterministic default model resolution order. */
export interface DefaultTaskModelResolverOptions {
  readonly taskSources?: Readonly<Partial<Record<ModelTask, TaskModelSource>>>;
  readonly defaultSource?: TaskModelSource;
  readonly hostCurrent?: TaskModelProvider;
  readonly configured?: TaskModelProvider;
  /** Allows an unavailable host-current binding to use the configured provider. */
  readonly allowConfiguredFallback?: boolean;
}

/**
 * Resolves explicit task policy first, then host-current, then the configured
 * provider. The result records fallback instead of silently changing models.
 */
export class DefaultTaskModelResolver implements TaskModelResolver {
  public constructor(private readonly options: DefaultTaskModelResolverOptions = {}) {}

  public async resolve(task: ModelTask, context: ModelResolutionContext): Promise<ResolvedTaskModel | undefined> {
    const requestedSource = this.options.taskSources?.[task] ?? this.options.defaultSource ?? "host-current";
    if (requestedSource === "disabled") return undefined;
    const request = { task, context } satisfies TaskModelProviderRequest;

    if (requestedSource === "configured-provider") {
      const binding = await this.options.configured?.resolve(request);
      return binding ? { ...binding, requestedSource, source: "configured-provider" } : undefined;
    }

    const hostBinding = context.canInvokeCurrentModel
      ? await this.options.hostCurrent?.resolve(request)
      : undefined;
    if (hostBinding) return { ...hostBinding, requestedSource, source: "host-current" };
    if (this.options.allowConfiguredFallback === false) return undefined;

    const configuredBinding = await this.options.configured?.resolve(request);
    return configuredBinding
      ? {
          ...configuredBinding,
          requestedSource,
          source: "configured-provider",
          fallbackReason: "host-current-unavailable",
        }
      : undefined;
  }
}
