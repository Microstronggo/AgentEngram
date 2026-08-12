export interface LocomoTurn {
  readonly dia_id?: string;
  readonly speaker?: string;
  readonly text?: string;
  readonly blip_caption?: string;
  readonly query?: string;
}

export interface LocomoQuestion {
  readonly question: string;
  readonly answer: unknown;
  readonly category: number;
  readonly evidence?: readonly string[];
}

export interface LocomoConversation {
  readonly speaker_a: string;
  readonly speaker_b: string;
  readonly [key: string]: unknown;
}

export interface LocomoSample {
  readonly conversation: LocomoConversation;
  readonly qa?: readonly LocomoQuestion[];
  readonly qa_pairs?: readonly LocomoQuestion[];
  readonly session_summary?: Readonly<Record<string, unknown>>;
  readonly event_summary?: Readonly<Record<string, unknown>>;
}

export interface LocomoSession {
  readonly key: string;
  readonly date: string;
  readonly turns: readonly LocomoTurn[];
}

export interface LocomoPreparedTurn {
  readonly conversationIndex: number;
  readonly sessionKey: string;
  readonly sessionDate: string;
  readonly diaId: string;
  readonly speaker: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly sourceRef: string;
  readonly timestamp: string;
}

export interface LocomoPreparedEpisode {
  readonly conversationIndex: number;
  readonly sessionKey: string;
  readonly sessionDate: string;
  readonly text: string;
  readonly sourceRefs: readonly string[];
  readonly timestamp: string;
  readonly episodeType: "session-summary" | "event-summary";
}

export interface LocomoQuestionItem {
  readonly id: string;
  readonly conversationIndex: number;
  readonly questionIndex: number;
  readonly category: number;
  readonly categoryName: string;
  readonly question: string;
  readonly answer: string;
  readonly evidence: readonly string[];
}
