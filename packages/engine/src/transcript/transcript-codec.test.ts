import { describe, expect, it } from "vitest";
import {
  decodeRawTranscriptRecord,
  encodeRawTranscriptRecord,
  validateRawTranscriptRecord,
} from "./transcript-codec.js";
import type { RawTranscriptRecord } from "./raw-transcript-record.js";

const record: RawTranscriptRecord = {
  schemaVersion: 1,
  id: "r1",
  framework: "pi-mono",
  frameworkSessionId: "s1",
  frameworkThreadId: "t1",
  frameworkEntryId: "e1",
  eventType: "message.created",
  role: "user",
  timestamp: "2026-06-24T00:00:00.000Z",
  content: { text: "hello" },
  contentHash: "hash",
  sourceRef: "agentengram://transcript/s1/t1/e1",
  frameworkSourceRef: "pi://session/s1/thread/t1/entry/e1",
  rawFrameworkPayload: { role: "user", content: "hello" },
};

describe("transcript codec", () => {
  it("serializes and parses raw transcript records", () => {
    expect(decodeRawTranscriptRecord(encodeRawTranscriptRecord(record))).toEqual(record);
  });

  it("rejects malformed records", () => {
    expect(() => validateRawTranscriptRecord({ ...record, id: "" })).toThrow("id");
  });

  it("preserves contentHash and blobRef", () => {
    const withBlob: RawTranscriptRecord = {
      ...record,
      contentHash: "abc",
      blobRef: { algorithm: "sha256", digest: "f".repeat(64), byteLength: 123, mediaType: "text/plain" },
    };
    expect(decodeRawTranscriptRecord(encodeRawTranscriptRecord(withBlob))).toMatchObject({
      contentHash: "abc",
      blobRef: { digest: "f".repeat(64) },
    });
  });

  it("keeps framework payload as untrusted metadata", () => {
    const parsed = decodeRawTranscriptRecord(encodeRawTranscriptRecord(record));
    expect(parsed.rawFrameworkPayload).toEqual({ role: "user", content: "hello" });
  });
});

