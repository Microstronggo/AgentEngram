import type { TranscriptAppendInput } from "./transcript-store.js";
import { TranscriptStore } from "./transcript-store.js";

/** Compatibility writer that serializes raw transcript appends within one process. */
export class TranscriptWriter {
  constructor(private readonly store: TranscriptStore) {}

  append(input: TranscriptAppendInput): Promise<void> {
    return this.store.append(input);
  }
}
