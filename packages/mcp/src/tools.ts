import type { MemoryPartition, MemoryRecord, MemoryScope, MemoryWriteCommand, MemoryWriteResult, RecallAudience, RememberInput } from "@agentengram/engine";

/** Structural application boundary shared by local runtimes and framework adapters. */
export interface MemoryApplicationLike {
  remember(input: RememberInput): Promise<MemoryRecord>;
  write(input: MemoryWriteCommand): Promise<MemoryWriteResult>;
  update(input: MemoryWriteCommand & { targetMemoryId: string }): Promise<MemoryWriteResult>;
  correct(input: MemoryWriteCommand & { targetMemoryId: string }): Promise<MemoryWriteResult>;
  search(input: { text: string; projectId?: string; scope?: MemoryScope; limit?: number; audience?: RecallAudience }): unknown | Promise<unknown>;
  read(scope: MemoryScope, id: string, projectId?: string, partition?: MemoryPartition): Promise<MemoryRecord | null>;
  forget(scope: MemoryScope, id: string, projectId?: string, partition?: MemoryPartition): Promise<boolean>;
  feedback(input: Omit<RememberInput, "type" | "kind"> & { targetMemoryId?: string }): Promise<MemoryRecord>;
  inspectContext(sessionId?: string): unknown | Promise<unknown>;
}

export function createMemoryToolHandlers(service: MemoryApplicationLike) {
  return {
    remember: (input: RememberInput) => service.remember(input),
    write: (input: MemoryWriteCommand) => service.write(input),
    update: (input: MemoryWriteCommand & { targetMemoryId: string }) => service.update(input),
    correct: (input: MemoryWriteCommand & { targetMemoryId: string }) => service.correct(input),
    search: (input: { text: string; projectId?: string; scope?: MemoryScope; limit?: number; audience?: RecallAudience }) => service.search(input),
    read: (input: { scope: MemoryScope; id: string; projectId?: string; partition?: MemoryPartition }) =>
      service.read(input.scope, input.id, input.projectId, input.partition),
    forget: (input: { scope: MemoryScope; id: string; projectId?: string; partition?: MemoryPartition }) =>
      service.forget(input.scope, input.id, input.projectId, input.partition),
    feedback: (input: Omit<RememberInput, "type" | "kind"> & { targetMemoryId?: string }) => service.feedback(input),
    inspectContext: (input: { sessionId?: string }) => service.inspectContext(input.sessionId),
  };
}

export function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
