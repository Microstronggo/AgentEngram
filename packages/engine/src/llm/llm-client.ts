/** Minimal chat message accepted by Engine-owned model operations. */
export interface LLMMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** Optional provider token accounting returned with a chat completion. */
export interface LLMUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly [key: string]: number | undefined;
}

/** Provider-neutral text completion result. */
export interface LLMChatResult {
  readonly content: string;
  readonly model: string;
  readonly usage?: Readonly<Record<string, number>>;
}

/** OpenAI-style endpoint configuration, defaulting to DashScope Qwen. */
export interface LLMClientOptions {
  /** Provider token; the default Qwen endpoint expects `DASHSCOPE_API_KEY`. */
  readonly apiKey: string;
  /** Provider endpoint without `/chat/completions`; defaults to DashScope Qwen. */
  readonly baseUrl?: string;
  /** Concrete model name; defaults to `qwen-plus`. */
  readonly model?: string;
  /** Injectable fetch implementation used by deterministic offline tests. */
  readonly fetch?: typeof fetch;
  /** Extra static headers for compatible gateways or organization routing. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Default deterministic decoding control. */
  readonly temperature?: number;
  /** Default output cap forwarded as `max_tokens`. */
  readonly maxTokens?: number;
}

/** Per-call cancellation and model-generation overrides. */
export interface LLMChatOptions {
  readonly signal?: AbortSignal;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseFormat?: "json_object";
}

/** Minimal client contract consumed by all Engine LLM memory components. */
/** Injectable chat boundary used by summarization and memory formation. */
export interface LLMChatClient {
  chat(messages: readonly LLMMessage[], options?: LLMChatOptions): Promise<LLMChatResult>;
}

/** Default OpenAI-compatible DashScope endpoint. */
export const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
/** Default model used when adapters do not provide an explicit Qwen model. */
export const DEFAULT_QWEN_MODEL = "qwen-plus";

/** Small subset of the chat-completions response schema needed by AgentEngram. */
interface ChatCompletionResponse {
  readonly model?: string;
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
    };
  }[];
  readonly usage?: LLMUsage;
  readonly error?: {
    readonly message?: string;
  };
}

/** Default Engine LLM client, currently configured for DashScope Qwen. */
export class LLMClient implements LLMChatClient {
  /** Fetch implementation; injected in tests and defaults to the runtime global. */
  private readonly fetchImpl: typeof fetch;

  /** @param options Authentication plus optional endpoint/model overrides. */
  public constructor(private readonly options: LLMClientOptions) {
    if (!options.apiKey.trim()) throw new Error("LLM apiKey is required");
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Sends one non-streaming chat request through the current compatible wire protocol. */
  public async chat(
    messages: readonly LLMMessage[],
    options: LLMChatOptions = {},
  ): Promise<LLMChatResult> {
    const model = this.options.model ?? DEFAULT_QWEN_MODEL;
    // The internal wire format currently matches OpenAI chat completions so
    // DashScope and compatible gateways can share one implementation. This is
    // deliberately not exposed in public class names; future transports can
    // implement LLMChatClient without changing memory components.
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
        ...this.options.headers,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? this.options.temperature ?? 0,
        max_tokens: options.maxTokens ?? this.options.maxTokens,
        ...(options.responseFormat ? { response_format: { type: options.responseFormat } } : {}),
      }),
    };
    if (options.signal) init.signal = options.signal;
    const response = await this.fetchImpl(
      `${trimTrailingSlash(this.options.baseUrl ?? DEFAULT_QWEN_BASE_URL)}/chat/completions`,
      init,
    );

    // Parse the provider body before checking status so a safe provider error
    // message is retained without ever exposing the configured API key.
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `LLM request failed with HTTP ${response.status}`);
    }

    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("LLM response did not include message content");
    return {
      content,
      model: payload.model ?? model,
      ...(payload.usage ? { usage: normalizeUsage(payload.usage) } : {}),
    };
  }
}

async function parseJsonResponse(response: Response): Promise<ChatCompletionResponse> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as ChatCompletionResponse;
  } catch (error) {
    throw new Error(`LLM response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Drops non-finite usage fields before exposing provider metadata to Engine. */
function normalizeUsage(usage: LLMUsage): Readonly<Record<string, number>> {
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value)) normalized[key] = value;
  }
  return normalized;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}
