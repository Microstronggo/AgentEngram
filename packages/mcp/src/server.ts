import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { MemoryScope, MemoryWriteCommand, RememberInput } from "@agentengram/engine";
import { createMemoryToolHandlers, toolResult, type MemoryApplicationLike } from "./tools.js";

const scope = z.enum(["user", "project", "local", "agent", "team"]);
const type = z.enum(["user", "feedback", "project", "reference"]);
const kind = z.enum(["preference", "correction", "decision", "convention", "failure", "insight", "tool-quirk"]);
const partition = z.object({
  schemaVersion: z.literal(1), appId: z.string().min(1).optional(), userId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(), teamId: z.string().min(1).optional(), projectId: z.string().min(1).optional(),
  worktreeId: z.string().min(1).optional(), namespace: z.string().min(1).optional(),
});
const identity = { scope, id: z.string().min(1), projectId: z.string().optional(), partition: partition.optional() };
const remember = {
  id: z.string().optional(), name: z.string().min(1), description: z.string().min(1), content: z.string().min(1),
  type, scope, kind: kind.optional(), projectId: z.string().optional(), sourceRefs: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(), importance: z.number().min(0).max(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
  assertedBy: z.enum(["user", "agent", "system", "extractor"]).optional(),
  epistemicStatus: z.enum(["asserted", "inferred", "corrected"]).optional(),
  partition: partition.optional(),
};

export function createMemoryMcpServer(service: MemoryApplicationLike): McpServer {
  const server = new McpServer({ name: "agentengram", version: "0.1.0" });
  const handlers = createMemoryToolHandlers(service);
  server.registerTool("memory.remember", { description: "Persist an explicit long-term memory", inputSchema: remember },
    async (input) => toolResult(await handlers.remember(clean(input) as unknown as RememberInput)));
  server.registerTool("memory.upsert", { description: "Idempotently create or update a long-term memory", inputSchema: remember },
    async (input) => toolResult(await handlers.write({ ...(clean(input) as unknown as RememberInput), operation: "upsert" })));
  server.registerTool("memory.update", { description: "Update a memory using optimistic revision checking", inputSchema: {
    ...remember, targetMemoryId: z.string().min(1), expectedRevision: z.number().int().min(1).optional(),
  } }, async (input) => toolResult(await handlers.update(clean(input) as unknown as MemoryWriteCommand & { targetMemoryId: string })));
  server.registerTool("memory.correct", { description: "Correct and supersede an existing memory without deleting history", inputSchema: {
    ...remember, type: z.never().optional(), kind: z.never().optional(), targetMemoryId: z.string().min(1), expectedRevision: z.number().int().min(1).optional(),
  } }, async ({ type: _type, kind: _kind, ...input }) => toolResult(await handlers.correct({
    ...(clean(input) as unknown as MemoryWriteCommand & { targetMemoryId: string }), type: "feedback", kind: "correction",
  })));
  server.registerTool("memory.search", { description: "Search relevant long-term memories", inputSchema: {
    text: z.string().min(1), projectId: z.string().optional(), scope: scope.optional(), limit: z.number().int().min(1).max(100).optional(),
    audience: z.object({
      appId: z.string().min(1).optional(), userId: z.string().min(1).optional(), agentId: z.string().min(1).optional(),
      teamIds: z.array(z.string().min(1)).optional(), projectId: z.string().min(1).optional(),
      worktreeId: z.string().min(1).optional(), namespace: z.string().min(1).optional(),
    }).optional(),
  } }, async (input) => toolResult(await handlers.search(clean(input) as Parameters<typeof handlers.search>[0])));
  server.registerTool("memory.read", { description: "Read one memory from the Markdown truth source", inputSchema: identity },
    async (input) => toolResult(await handlers.read(clean(input) as Parameters<typeof handlers.read>[0])));
  server.registerTool("memory.forget", { description: "Delete one memory and its search index entry", inputSchema: identity },
    async (input) => toolResult(await handlers.forget(clean(input) as Parameters<typeof handlers.forget>[0])));
  server.registerTool("memory.feedback", { description: "Persist an explicit user correction", inputSchema: {
    ...remember, type: z.never().optional(), kind: z.never().optional(), targetMemoryId: z.string().min(1).optional(),
  } }, async ({ type: _type, kind: _kind, ...input }) => toolResult(await handlers.feedback(clean(input) as Omit<RememberInput, "type" | "kind">)));
  server.registerTool("context.inspect", { description: "Inspect AgentEngram session/runtime state", inputSchema: {
    sessionId: z.string().optional(),
  } }, async (input) => toolResult(await handlers.inspectContext(clean(input) as { sessionId?: string })));
  return server;
}

function clean<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
