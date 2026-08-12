import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  LocomoPreparedEpisode,
  LocomoPreparedTurn,
  LocomoQuestionItem,
  LocomoSample,
  LocomoSession,
  LocomoTurn,
} from "./types.js";

const LOCOMO_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

export const LOCOMO_CATEGORY_NAMES: Readonly<Record<number, string>> = {
  1: "multi-hop",
  2: "temporal",
  3: "open-domain",
  4: "single-hop",
  5: "adversarial",
};

export const LOCOMO_SCORING_CATEGORIES = [1, 2, 3, 4] as const;

export async function loadOrDownloadLocomoDataset(options: {
  readonly datasetPath?: string;
  readonly datasetDir: string;
}): Promise<{ readonly path: string; readonly samples: readonly LocomoSample[] }> {
  const path = options.datasetPath ?? join(options.datasetDir, "locomo10.json");
  try {
    return { path, samples: await loadLocomoDataset(path) };
  } catch (error) {
    if (options.datasetPath) throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const response = await fetch(LOCOMO_URL);
  if (!response.ok) throw new Error(`failed to download LoCoMo dataset: ${response.status} ${response.statusText}`);
  await writeFile(path, await response.text(), "utf8");
  return { path, samples: await loadLocomoDataset(path) };
}

export async function loadLocomoDataset(path: string): Promise<readonly LocomoSample[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("LoCoMo dataset must be a JSON array");
  return parsed as LocomoSample[];
}

export function getSortedSessions(sample: LocomoSample): readonly LocomoSession[] {
  const conversation = sample.conversation;
  const sessions: LocomoSession[] = [];
  for (const key of Object.keys(conversation)) {
    if (!/^session_\d+$/.test(key)) continue;
    const turns = conversation[key];
    if (!Array.isArray(turns)) continue;
    const dateValue = conversation[`${key}_date_time`];
    const date = typeof dateValue === "string" ? dateValue : "";
    sessions.push({ key, date, turns: turns as LocomoTurn[] });
  }
  return sessions.sort((a, b) => {
    const aDate = parseLocomoDate(a.date)?.getTime();
    const bDate = parseLocomoDate(b.date)?.getTime();
    if (aDate !== undefined && bDate !== undefined) return aDate - bDate;
    return sessionNumber(a.key) - sessionNumber(b.key);
  });
}

export function prepareTurns(sample: LocomoSample, conversationIndex: number): readonly LocomoPreparedTurn[] {
  const output: LocomoPreparedTurn[] = [];
  const speakerA = sample.conversation.speaker_a;
  for (const session of getSortedSessions(sample)) {
    const timestamp = parseLocomoDate(session.date)?.toISOString() ?? new Date(0).toISOString();
    for (const [turnIndex, turn] of session.turns.entries()) {
      const text = turnText(turn);
      if (!text) continue;
      const speaker = turn.speaker ?? "unknown";
      const diaId = turn.dia_id || `${session.key}_${turnIndex}`;
      output.push({
        conversationIndex,
        sessionKey: session.key,
        sessionDate: session.date,
        diaId,
        speaker,
        role: speaker === speakerA ? "user" : "assistant",
        text: `${speaker}: ${text}`,
        sourceRef: locomoSourceRef(conversationIndex, session.key, diaId),
        timestamp,
      });
    }
  }
  return output;
}

export function prepareEpisodes(sample: LocomoSample, conversationIndex: number): readonly LocomoPreparedEpisode[] {
  const turns = prepareTurns(sample, conversationIndex);
  const turnsBySession = new Map<string, LocomoPreparedTurn[]>();
  for (const turn of turns) {
    const bucket = turnsBySession.get(turn.sessionKey) ?? [];
    bucket.push(turn);
    turnsBySession.set(turn.sessionKey, bucket);
  }

  const episodes: LocomoPreparedEpisode[] = [];
  for (const session of getSortedSessions(sample)) {
    const sessionTurns = turnsBySession.get(session.key) ?? [];
    if (sessionTurns.length === 0) continue;
    const timestamp = sessionTurns[0]?.timestamp ?? parseLocomoDate(session.date)?.toISOString() ?? new Date(0).toISOString();
    const sourceRefs = sessionTurns.map((turn) => turn.sourceRef);
    const sessionSummary = summaryText(sample.session_summary?.[`${session.key}_summary`] ?? sample.session_summary?.[session.key]);
    if (sessionSummary) {
      episodes.push({
        conversationIndex,
        sessionKey: session.key,
        sessionDate: session.date,
        timestamp,
        sourceRefs,
        episodeType: "session-summary",
        text: `Session date: ${session.date}\n${sessionSummary}`,
      });
    }
    const eventSummary = eventSummaryText(sample.event_summary?.[`events_${session.key}`]);
    if (eventSummary) {
      episodes.push({
        conversationIndex,
        sessionKey: session.key,
        sessionDate: session.date,
        timestamp,
        sourceRefs,
        episodeType: "event-summary",
        text: `Session date: ${session.date}\n${eventSummary}`,
      });
    }
  }
  return episodes;
}

export function getQuestionItems(
  sample: LocomoSample,
  conversationIndex: number,
  categories: readonly number[],
  maxQuestions?: number,
): readonly LocomoQuestionItem[] {
  const questions = [...(sample.qa ?? sample.qa_pairs ?? [])].filter((question) => categories.includes(question.category));
  const limited = maxQuestions === undefined ? questions : questions.slice(0, maxQuestions);
  return limited.map((question, index) => ({
    id: `conv${conversationIndex}_q${index}`,
    conversationIndex,
    questionIndex: index,
    category: question.category,
    categoryName: LOCOMO_CATEGORY_NAMES[question.category] ?? "unknown",
    question: question.question,
    answer: String(question.answer),
    evidence: [...(question.evidence ?? [])],
  }));
}

export function locomoSourceRef(conversationIndex: number, sessionKey: string, diaId: string): string {
  return `locomo://conv${conversationIndex}/${sessionKey}/${diaId}`;
}

export function sourceRefDiaId(sourceRef: string): string | undefined {
  return sourceRef.split("/").at(-1);
}

function turnText(turn: LocomoTurn): string {
  const text = turn.text?.trim() ?? "";
  const query = turn.query?.trim() ?? "";
  const blip = turn.blip_caption?.trim() ?? "";
  const photo = query && blip
    ? `[Sharing image - query: ${query}. The image shows: ${blip}]`
    : query
      ? `[Sharing image - query for: ${query}]`
      : blip
        ? `[Sharing image that shows: ${blip}]`
        : "";
  return [text, photo].filter(Boolean).join(" ").trim();
}

function summaryText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function eventSummaryText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  const date = typeof record.date === "string" ? record.date.trim() : "";
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(record)) {
    if (key === "date" || !Array.isArray(raw)) continue;
    for (const item of raw) {
      if (typeof item === "string" && item.trim()) lines.push(`${key}: ${item.trim()}`);
    }
  }
  return [date ? `Event date: ${date}` : "", ...lines].filter(Boolean).join("\n");
}

function parseLocomoDate(value: string): Date | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  const match = /(\d{1,2}):(\d{2})\s*([ap]m)\s+on\s+(\d{1,2})\s+([A-Za-z]+),\s+(\d{4})/i.exec(normalized);
  if (!match) return undefined;
  const [, hourRaw, minuteRaw, meridiemRaw, dayRaw, monthRaw, yearRaw] = match;
  if (!hourRaw || !minuteRaw || !meridiemRaw || !dayRaw || !monthRaw || !yearRaw) return undefined;
  const month = monthIndex(monthRaw);
  if (month < 0) return undefined;
  let hour = Number.parseInt(hourRaw, 10);
  const minute = Number.parseInt(minuteRaw, 10);
  const meridiem = meridiemRaw.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return new Date(Date.UTC(Number.parseInt(yearRaw, 10), month, Number.parseInt(dayRaw, 10), hour, minute));
}

function monthIndex(value: string): number {
  return [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ].findIndex((month) => month.startsWith(value.toLowerCase()));
}

function sessionNumber(value: string): number {
  return Number.parseInt(/\d+/.exec(value)?.[0] ?? "0", 10);
}
