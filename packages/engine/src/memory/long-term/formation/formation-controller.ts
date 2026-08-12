import type { MemoryObservation } from "./memory-formation.js";

/** Lightweight turn signal collected by the legacy threshold buffer. */
export interface FormationSignal {
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly sourceRef: string;
  readonly projectId?: string;
  readonly toolCall?: boolean;
}

/** Explicit user intent that should bypass ordinary background thresholds. */
export type ExplicitMemoryIntent = "remember" | "forget" | "correction" | null;

/** Conservative lexical detector. Hosts may replace it with their current model. */
export function detectExplicitMemoryIntent(text: string): ExplicitMemoryIntent {
  const normalized = text.trim().toLowerCase();
  if (/\b(forget|do not remember)\b|忘记|不要记住/.test(normalized)) return "forget";
  if (/\b(remember|keep in mind|always use)\b|记住|以后都|请记下/.test(normalized)) return "remember";
  if (/\b(no[,，]?|actually|instead|correction)\b|不是这样|改成|纠正|应该用/.test(normalized)) return "correction";
  return null;
}

/** Legacy turn/tool thresholds retained for non-Cell integrations. */
export interface BackgroundFormationBufferOptions {
  readonly turnThreshold?: number;
  readonly toolCallThreshold?: number;
  readonly minimumTextCharacters?: number;
}

/** Accumulates prose-bearing turns; pure tool noise never triggers extraction by itself. */
export class BackgroundFormationBuffer {
  /** Signals retained until prose and activity thresholds are both satisfied. */
  private signals: FormationSignal[] = [];
  /** User-turn count in the current extraction window. */
  private turns = 0;
  /** Tool-call count in the current extraction window. */
  private toolCalls = 0;
  /** User-turn threshold that can trigger a batch. */
  private readonly turnThreshold: number;
  /** Tool activity threshold that can trigger a batch when prose is present. */
  private readonly toolCallThreshold: number;
  /** Minimum non-tool text required to avoid extracting from operational noise. */
  private readonly minimumTextCharacters: number;

  public constructor(options: BackgroundFormationBufferOptions = {}) {
    this.turnThreshold = positive(options.turnThreshold ?? 8);
    this.toolCallThreshold = positive(options.toolCallThreshold ?? 20);
    this.minimumTextCharacters = positive(options.minimumTextCharacters ?? 80);
  }

  /** Adds one signal and emits a prose observation only when thresholds are met. */
  public add(signal: FormationSignal): MemoryObservation | null {
    this.signals.push(signal);
    if (signal.role === "user") this.turns++;
    if (signal.toolCall) this.toolCalls++;
    const prose = this.signals.filter(item => item.role !== "tool").map(item => item.text.trim()).filter(Boolean);
    if ((this.turns < this.turnThreshold && this.toolCalls < this.toolCallThreshold) || prose.join(" ").length < this.minimumTextCharacters) {
      return null;
    }
    const batch = this.signals;
    this.signals = [];
    this.turns = 0;
    this.toolCalls = 0;
    return {
      text: batch.filter(item => item.role !== "tool").map(item => `${item.role}: ${item.text}`).join("\n"),
      sourceRefs: batch.map(item => item.sourceRef),
      ...(signal.projectId ? { projectId: signal.projectId } : {}),
      metadata: { formation: "background", signalCount: batch.length },
    };
  }
}

function positive(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError("formation threshold must be positive");
  return Math.floor(value);
}
