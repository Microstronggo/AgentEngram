import { createFrameworkSourceRef, createTranscriptSourceRef } from "@agentengram/engine/adapter";

export function createPiTranscriptSourceRefs(input: {
  readonly sessionId: string;
  readonly threadId: string;
  readonly entryId: string;
}): { readonly sourceRef: string; readonly frameworkSourceRef: string } {
  return {
    sourceRef: createTranscriptSourceRef(input),
    frameworkSourceRef: createFrameworkSourceRef({ framework: "pi", ...input }),
  };
}

