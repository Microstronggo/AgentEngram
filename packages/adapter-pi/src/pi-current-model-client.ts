import type {
  HostModelBridge,
  HostModelReference,
  LLMChatClient,
  LLMChatOptions,
  LLMChatResult,
  LLMMessage,
} from "@agentengram/engine/public";
import type {
  PiContext,
  PiModel,
  PiModelRegistry,
  PiResolvedRequestAuth,
} from "./pi-types.js";

/** Small Pi-AI completion surface injected by tests and loaded lazily in Pi. */
export type PiCompletionFunction = (
  model: PiModel,
  context: PiCompletionContext,
  options: PiCompletionOptions,
) => Promise<PiAssistantMessage>;

/** Provider-neutral Pi context used for AgentEngram's internal model tasks. */
export interface PiCompletionContext {
  readonly systemPrompt?: string;
  readonly messages: readonly PiCompletionMessage[];
}

export type PiCompletionMessage =
  | { readonly role: "user"; readonly content: string; readonly timestamp: number }
  | {
      readonly role: "assistant";
      readonly content: readonly { readonly type: "text"; readonly text: string }[];
      readonly api: string;
      readonly provider: string;
      readonly model: string;
      readonly usage: PiAssistantUsage;
      readonly stopReason: "stop";
      readonly timestamp: number;
    };

/** Authentication and generation options accepted by Pi's completeSimple. */
export interface PiCompletionOptions {
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface PiAssistantUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

/** Minimal successful/error assistant response returned by Pi-AI. */
export interface PiAssistantMessage {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly model?: string;
  readonly responseModel?: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly usage?: Partial<PiAssistantUsage>;
}

/** Observable routing decision for diagnostics without exposing credentials. */
export interface PiModelInvocationDecision {
  readonly source: "host-current" | "configured-fallback";
  readonly requestedModel?: string;
  readonly actualModel?: string;
  readonly fallbackReason?: string;
}

export interface PiCurrentModelLLMClientOptions {
  readonly complete?: PiCompletionFunction;
  readonly fallback?: LLMChatClient;
  readonly now?: () => number;
}

interface PiModelSnapshot {
  readonly model: PiModel;
  readonly registry: PiModelRegistry;
  readonly selectedAt: string;
}

/**
 * Adapts Pi's active provider/model to Engine's small LLMChatClient contract.
 * Credentials are resolved immediately before each call and are never retained
 * in transcript, durable jobs, diagnostics, or model references.
 */
export class PiCurrentModelLLMClient implements LLMChatClient, HostModelBridge<LLMChatClient> {
  /** Latest immutable model/registry pair observed from a Pi hook context. */
  private current: PiModelSnapshot | undefined;
  /** Previously observed models retained for durable jobs queued before model_select. */
  private readonly snapshots = new Map<string, PiModelSnapshot>();
  /** Last credential-free routing outcome exposed through context diagnostics. */
  private decision: PiModelInvocationDecision | undefined;
  private readonly complete: PiCompletionFunction;
  private readonly now: () => number;

  public constructor(private readonly options: PiCurrentModelLLMClientOptions = {}) {
    this.complete = options.complete ?? completeWithBundledPi;
    this.now = options.now ?? Date.now;
  }

  /** Updates the bridge from trusted hook context; later calls see model changes. */
  public observe(context: PiContext): void {
    if (!context.model || !context.modelRegistry) {
      this.current = undefined;
      return;
    }
    const snapshot = {
      model: context.model,
      registry: context.modelRegistry,
      selectedAt: new Date(this.now()).toISOString(),
    } satisfies PiModelSnapshot;
    this.current = snapshot;
    this.snapshots.set(modelKey(snapshot.model.provider, snapshot.model.id), snapshot);
  }

  /** Returns only credential-free metadata suitable for a durable job payload. */
  public currentModel(): HostModelReference | undefined {
    const snapshot = this.current;
    return snapshot === undefined ? undefined : {
      provider: snapshot.model.provider,
      model: snapshot.model.id,
      selectedAt: snapshot.selectedAt,
    };
  }

  /** Creates an immutable client for the exact model captured when a job was queued. */
  public invokeClient(reference?: HostModelReference): LLMChatClient | undefined {
    const snapshot = reference
      ? this.snapshots.get(modelKey(reference.provider, reference.model))
      : this.current;
    if (snapshot) {
      return { chat: (messages, options) => this.chatSnapshot(snapshot, messages, options ?? {}) };
    }
    // Never substitute a different current host model for a durable reference.
    // Returning undefined lets TaskModelResolver apply the configured fallback
    // explicitly and retain an observable fallback reason.
    return reference === undefined ? this.options.fallback : undefined;
  }

  /** Returns a credential-free copy of the last routing decision. */
  public lastDecision(): PiModelInvocationDecision | undefined {
    return this.decision === undefined ? undefined : { ...this.decision };
  }

  public async chat(messages: readonly LLMMessage[], options: LLMChatOptions = {}): Promise<LLMChatResult> {
    // Snapshot once so a model_select event cannot change an in-flight request.
    const snapshot = this.current;
    if (!snapshot) return this.useFallback(messages, options, "Pi current model is unavailable");
    return this.chatSnapshot(snapshot, messages, options);
  }

  /** Invokes one fixed snapshot; all credentials are still resolved just in time. */
  private async chatSnapshot(
    snapshot: PiModelSnapshot,
    messages: readonly LLMMessage[],
    options: LLMChatOptions,
  ): Promise<LLMChatResult> {
    const requestedModel = `${snapshot.model.provider}/${snapshot.model.id}`;
    let auth: PiResolvedRequestAuth;
    try {
      auth = await snapshot.registry.getApiKeyAndHeaders(snapshot.model);
    } catch (error) {
      return this.useFallback(messages, options, errorMessage(error), requestedModel);
    }
    if (!auth.ok) return this.useFallback(messages, options, auth.error, requestedModel);

    try {
      const response = await this.complete(
        snapshot.model,
        toPiCompletionContext(messages, snapshot.model, this.now),
        {
          ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
          ...(auth.headers === undefined ? {} : { headers: auth.headers }),
          ...(auth.env === undefined ? {} : { env: auth.env }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        },
      );
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage ?? `Pi model stopped with ${response.stopReason}`);
      }
      const content = response.content
        ?.filter((item): item is { readonly type: "text"; readonly text: string } =>
          item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
        .trim();
      if (!content) throw new Error("Pi current model returned no text content");
      const actualModel = response.responseModel ?? response.model ?? snapshot.model.id;
      this.decision = { source: "host-current", requestedModel, actualModel };
      return {
        content,
        model: actualModel,
        ...(response.usage === undefined ? {} : { usage: normalizeUsage(response.usage) }),
      };
    } catch (error) {
      return this.useFallback(messages, options, errorMessage(error), requestedModel);
    }
  }

  /** Uses an explicitly configured provider only when host invocation fails. */
  private async useFallback(
    messages: readonly LLMMessage[],
    options: LLMChatOptions,
    reason: string,
    requestedModel?: string,
  ): Promise<LLMChatResult> {
    if (!this.options.fallback) throw new Error(reason);
    const result = await this.options.fallback.chat(messages, options);
    this.decision = {
      source: "configured-fallback",
      ...(requestedModel === undefined ? {} : { requestedModel }),
      actualModel: result.model,
      fallbackReason: reason,
    };
    return result;
  }
}

function modelKey(provider: string | undefined, model: string): string {
  return `${provider ?? ""}\0${model}`;
}

function toPiCompletionContext(
  messages: readonly LLMMessage[],
  model: PiModel,
  now: () => number,
): PiCompletionContext {
  const systemPrompt = messages
    .filter(({ role }) => role === "system")
    .map(({ content }) => content)
    .join("\n\n")
    .trim();
  const converted: PiCompletionMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      converted.push({ role: "user", content: message.content, timestamp: now() });
      continue;
    }
    converted.push({
      role: "assistant",
      content: [{ type: "text", text: message.content }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: now(),
    });
  }
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages: converted,
  };
}

/** Lazy loading keeps ordinary unit tests independent from a concrete Pi install. */
async function completeWithBundledPi(
  model: PiModel,
  context: PiCompletionContext,
  options: PiCompletionOptions,
): Promise<PiAssistantMessage> {
  const moduleName = "@earendil-works/pi-ai/compat";
  const module = await import(moduleName) as {
    readonly completeSimple?: PiCompletionFunction;
  };
  if (typeof module.completeSimple !== "function") {
    throw new Error("Pi AI completeSimple is unavailable");
  }
  return module.completeSimple(model, context, options);
}

function emptyUsage(): PiAssistantUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function normalizeUsage(usage: Partial<PiAssistantUsage>): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
