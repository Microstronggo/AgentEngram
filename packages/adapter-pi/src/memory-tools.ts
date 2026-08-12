import {
  isMemoryKind,
  isMemoryScope,
  isMemoryType,
  resolveProjectIdentity,
  type MemoryKind,
  type MemoryScope,
  type MemoryType,
  type MemoryWriteCommand,
  type RememberInput,
  type ProjectIdentity,
} from "@agentengram/engine";
import { Type, type TSchema } from "typebox";
import type { ErrorReporter } from "./fail-open.js";
import type { PiContext, PiExtensionApi, PiJsonSchema, PiToolDefinition, PiToolResult } from "./pi-types.js";
import type { MemoryApplicationFacade, ModelFacingScopeIdentity } from "./types.js";

export const PI_MEMORY_TOOL_NAMES = [
  "memory_remember",
  "memory_upsert",
  "memory_update",
  "memory_correct",
  "memory_search",
  "memory_read",
  "memory_forget",
  "memory_feedback",
  "context_inspect",
] as const;

type ObjectInput = Record<string, unknown>;

const scopeSchema = Type.Union(["user", "project", "local", "agent", "team"].map((value) => Type.Literal(value)));
const typeSchema = Type.Union(["user", "feedback", "project", "reference"].map((value) => Type.Literal(value)));
const kindSchema = Type.Union(
  ["preference", "correction", "decision", "convention", "failure", "insight", "tool-quirk"]
    .map((value) => Type.Literal(value)),
);

const identityProperties = {
  scope: scopeSchema,
  id: Type.String({ minLength: 1 }),
  projectId: Type.String({ minLength: 1 }),
};

const rememberProperties = {
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  content: Type.String({ minLength: 1 }),
  type: typeSchema,
  scope: scopeSchema,
  kind: kindSchema,
  projectId: Type.String({ minLength: 1 }),
  sourceRefs: Type.Array(Type.String({ minLength: 1 })),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  importance: Type.Number({ minimum: 0, maximum: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
  assertedBy: Type.Union(["user", "agent", "system", "extractor"].map((value) => Type.Literal(value))),
  epistemicStatus: Type.Union(["asserted", "inferred", "corrected"].map((value) => Type.Literal(value))),
};
const { type: _feedbackType, kind: _feedbackKind, ...feedbackProperties } = rememberProperties;

function objectSchema(
  properties: Readonly<Record<string, TSchema>>,
  required: readonly string[] = [],
): PiJsonSchema {
  const requiredKeys = new Set(required);
  return Type.Object(
    Object.fromEntries(Object.entries(properties).map(([key, schema]) => [
      key,
      requiredKeys.has(key) ? schema : Type.Optional(schema),
    ])),
    { additionalProperties: false },
  );
}

function tool(
  definition: Omit<PiToolDefinition, "execute"> & {
    run(params: unknown, context: PiContext): unknown | Promise<unknown>;
  },
  report: ErrorReporter,
): PiToolDefinition {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (signal?.aborted) return failure("operation aborted");
      try {
        const value = await definition.run(params, context);
        return success(value);
      } catch (error) {
        report(error, definition.name, context);
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerMemoryTools(
  pi: PiExtensionApi,
  application: MemoryApplicationFacade | undefined,
  report: ErrorReporter,
  scopeIdentity: ModelFacingScopeIdentity = {},
): void {
  if (!pi.registerTool || !application) return;

  const tools: PiToolDefinition[] = [
    tool({
      name: "memory_remember",
      label: "Remember",
      description: "Store a durable AgentEngram fact, preference, correction, decision, or convention.",
      parameters: objectSchema(rememberProperties, ["name", "description", "content", "type", "scope"]),
      run: async (params, context) => application.remember(parseRemember(
        params,
        await defaultProjectIdentity(context),
        scopeIdentity,
      )),
    }, report),
    tool({
      name: "memory_upsert",
      label: "Upsert Memory",
      description: "Idempotently create or update a durable memory.",
      parameters: objectSchema(rememberProperties, ["name", "description", "content", "type", "scope"]),
      run: async (params, context) => application.write({
        ...parseRemember(params, await defaultProjectIdentity(context), scopeIdentity), operation: "upsert",
      }),
    }, report),
    tool({
      name: "memory_update",
      label: "Update Memory",
      description: "Update a durable memory with optional optimistic revision checking.",
      parameters: objectSchema({
        ...rememberProperties,
        targetMemoryId: Type.String({ minLength: 1 }),
        expectedRevision: Type.Integer({ minimum: 1 }),
      }, ["name", "description", "content", "type", "scope", "targetMemoryId"]),
      run: async (params, context) => application.update(
        parseMutation(params, await defaultProjectIdentity(context), scopeIdentity, "update"),
      ),
    }, report),
    tool({
      name: "memory_correct",
      label: "Correct Memory",
      description: "Correct and supersede a durable memory while preserving history.",
      parameters: objectSchema({
        ...feedbackProperties,
        targetMemoryId: Type.String({ minLength: 1 }),
        expectedRevision: Type.Integer({ minimum: 1 }),
      }, ["name", "description", "content", "scope", "targetMemoryId"]),
      run: async (params, context) => application.correct(parseMutation(
        { ...asObject(params), type: "feedback", kind: "correction" },
        await defaultProjectIdentity(context),
        scopeIdentity,
        "correct",
      )),
    }, report),
    tool({
      name: "memory_search",
      label: "Search Memory",
      description: "Search durable AgentEngram records using full-text search.",
      parameters: objectSchema({
        text: Type.String({ minLength: 1 }),
        projectId: Type.String({ minLength: 1 }),
        scope: scopeSchema,
        limit: Type.Integer({ minimum: 1, maximum: 100 }),
      }, ["text"]),
      run: async (params, context) => application.search(parseSearch(
        params,
        await defaultProjectIdentity(context),
        scopeIdentity,
      )),
    }, report),
    tool({
      name: "memory_read",
      label: "Read Memory",
      description: "Read one durable AgentEngram record by scope and id.",
      parameters: objectSchema(identityProperties, ["scope", "id"]),
      run: async (params, context) => {
        const input = parseIdentity(params, await defaultProjectIdentity(context), scopeIdentity);
        return input.partition
          ? application.read(input.scope, input.id, input.projectId, input.partition)
          : application.read(input.scope, input.id, input.projectId);
      },
    }, report),
    tool({
      name: "memory_forget",
      label: "Forget Memory",
      description: "Remove one durable AgentEngram record by scope and id.",
      parameters: objectSchema(identityProperties, ["scope", "id"]),
      run: async (params, context) => {
        const input = parseIdentity(params, await defaultProjectIdentity(context), scopeIdentity);
        return input.partition
          ? application.forget(input.scope, input.id, input.projectId, input.partition)
          : application.forget(input.scope, input.id, input.projectId);
      },
    }, report),
    tool({
      name: "memory_feedback",
      label: "Memory Feedback",
      description: "Store a durable user correction so future agent sessions can apply it.",
      parameters: objectSchema(feedbackProperties, ["name", "description", "content", "scope"]),
      run: async (params, context) => application.feedback(parseFeedback(
        params,
        await defaultProjectIdentity(context),
        scopeIdentity,
      )),
    }, report),
    tool({
      name: "context_inspect",
      label: "Inspect Context",
      description: "Inspect AgentEngram runtime context diagnostics for a session.",
      parameters: objectSchema({ sessionId: Type.String({ minLength: 1 }) }),
      run: (params, context) => {
        const input = asObject(params);
        assertKnownKeys(input, ["sessionId"]);
        const sessionId = optionalString(input, "sessionId")
          ?? context.sessionManager.getSessionId?.()
          ?? context.sessionManager.getSessionFile();
        return application.inspectContext(sessionId);
      },
    }, report),
  ];

  for (const definition of tools) pi.registerTool(definition);
}

function parseRemember(
  value: unknown,
  defaultIdentity: ProjectIdentity | undefined,
  scopeIdentity: ModelFacingScopeIdentity,
): RememberInput {
  const input = asObject(value);
  assertKnownKeys(input, Object.keys(rememberProperties));
  const scope = memoryScope(input.scope);
  const projectId = trustedProjectId(input, scope, defaultIdentity);
  const id = optionalString(input, "id");
  requireProjectId(scope, projectId);
  const partition = trustedPartition(scope, projectId, defaultIdentity, scopeIdentity);
  const result: RememberInput = {
    name: requiredString(input, "name"),
    description: requiredString(input, "description"),
    content: requiredString(input, "content"),
    type: memoryType(input.type),
    scope,
    ...(id === undefined ? {} : { id }),
    ...(input.kind === undefined ? {} : { kind: memoryKind(input.kind) }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(partition === undefined ? {} : { partition }),
    ...(input.sourceRefs === undefined ? {} : { sourceRefs: stringArray(input.sourceRefs, "sourceRefs") }),
    ...(input.confidence === undefined ? {} : { confidence: unitNumber(input.confidence, "confidence") }),
    ...(input.importance === undefined ? {} : { importance: unitNumber(input.importance, "importance") }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: requiredString(input, "idempotencyKey") }),
    ...(input.assertedBy === undefined ? {} : { assertedBy: parseAssertedBy(input.assertedBy) }),
    ...(input.epistemicStatus === undefined ? {} : { epistemicStatus: parseEpistemicStatus(input.epistemicStatus) }),
  };
  return result;
}

function parseMutation(
  value: unknown,
  identity: ProjectIdentity,
  scopeIdentity: ModelFacingScopeIdentity,
  operation: "update" | "correct",
): MemoryWriteCommand & { targetMemoryId: string } {
  const input = asObject(value);
  const targetMemoryId = requiredString(input, "targetMemoryId");
  const expectedRevision = input.expectedRevision === undefined
    ? undefined
    : integer(input.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
  const { targetMemoryId: _target, expectedRevision: _revision, ...remember } = input;
  return {
    ...parseRemember(remember, identity, scopeIdentity),
    operation,
    targetMemoryId,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

function parseFeedback(
  value: unknown,
  defaultIdentity: ProjectIdentity | undefined,
  scopeIdentity: ModelFacingScopeIdentity,
): Omit<RememberInput, "type" | "kind"> {
  const input = asObject(value);
  if (input.type !== undefined || input.kind !== undefined) throw new Error("feedback does not accept type or kind");
  const parsed = parseRemember({ ...input, type: "feedback" }, defaultIdentity, scopeIdentity);
  const { type: _type, kind: _kind, ...feedback } = parsed;
  return feedback;
}

function parseSearch(
  value: unknown,
  defaultIdentity: ProjectIdentity | undefined,
  scopeIdentity: ModelFacingScopeIdentity,
): {
  text: string;
  projectId?: string;
  scope?: MemoryScope;
  limit?: number;
  audience?: { projectId: string; worktreeId: string; userId: string; agentId: string; teamIds: readonly string[] };
} {
  const input = asObject(value);
  assertKnownKeys(input, ["text", "projectId", "scope", "limit"]);
  const scope = input.scope === undefined ? undefined : memoryScope(input.scope);
  const projectId = trustedProjectId(input, scope, defaultIdentity, scope === undefined);
  if (scope !== undefined) requireProjectId(scope, projectId);
  if (scope !== undefined) assertStableScopeIdentity(scope, scopeIdentity);
  const limit = input.limit === undefined ? undefined : integer(input.limit, "limit", 1, 100);
  return {
    text: requiredString(input, "text"),
    ...(projectId === undefined ? {} : { projectId }),
    ...(scope === undefined ? {} : { scope }),
    ...(limit === undefined ? {} : { limit }),
    ...(defaultIdentity && projectId === defaultIdentity.projectId ? { audience: {
      projectId,
      worktreeId: defaultIdentity.worktreeId,
      userId: scopeIdentity.userId ?? "__unavailable_user__",
      agentId: scopeIdentity.agentId ?? "__unavailable_agent__",
      teamIds: scopeIdentity.teamId === undefined ? [] : [scopeIdentity.teamId],
    } } : {}),
  };
}

function parseIdentity(
  value: unknown,
  defaultIdentity: ProjectIdentity | undefined,
  scopeIdentity: ModelFacingScopeIdentity,
): {
  scope: MemoryScope;
  id: string;
  projectId?: string;
  partition?: RememberInput["partition"];
} {
  const input = asObject(value);
  assertKnownKeys(input, ["scope", "id", "projectId"]);
  const scope = memoryScope(input.scope);
  const projectId = trustedProjectId(input, scope, defaultIdentity);
  requireProjectId(scope, projectId);
  const partition = trustedPartition(scope, projectId, defaultIdentity, scopeIdentity);
  return {
    scope,
    id: requiredString(input, "id"),
    ...(projectId === undefined ? {} : { projectId }),
    ...(partition === undefined ? {} : { partition }),
  };
}

function asObject(value: unknown): ObjectInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("parameters must be an object");
  }
  return value as ObjectInput;
}

function assertKnownKeys(input: ObjectInput, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`unknown parameter: ${unknown}`);
}

function requiredString(input: ObjectInput, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function optionalString(input: ObjectInput, key: string): string | undefined {
  return input[key] === undefined ? undefined : requiredString(input, key);
}

function memoryScope(value: unknown): MemoryScope {
  if (typeof value !== "string" || !isMemoryScope(value)) throw new Error("scope is invalid");
  return value;
}

function memoryType(value: unknown): MemoryType {
  if (typeof value !== "string" || !isMemoryType(value)) throw new Error("type is invalid");
  return value;
}

function memoryKind(value: unknown): MemoryKind {
  if (typeof value !== "string" || !isMemoryKind(value)) throw new Error("kind is invalid");
  return value;
}

function parseAssertedBy(value: unknown): NonNullable<RememberInput["assertedBy"]> {
  if (value === "user" || value === "agent" || value === "system" || value === "extractor") return value;
  throw new Error("assertedBy is invalid");
}

function parseEpistemicStatus(value: unknown): NonNullable<RememberInput["epistemicStatus"]> {
  if (value === "asserted" || value === "inferred" || value === "corrected") return value;
  throw new Error("epistemicStatus is invalid");
}

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  return value.map((item) => (item as string).trim());
}

function unitNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${key} must be between 0 and 1`);
  }
  return value;
}

function integer(value: unknown, key: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function requireProjectId(scope: MemoryScope, projectId: string | undefined): void {
  if ((scope === "project" || scope === "local" || scope === "team") && projectId === undefined) {
    throw new Error(`projectId is required for ${scope} scope`);
  }
}

/**
 * Builds a partition exclusively from trusted adapter configuration. Global
 * model-facing scopes remain unavailable until the host supplies a stable id;
 * falling back to legacy shared ids would leak memory between users or agents.
 */
function trustedPartition(
  scope: MemoryScope,
  projectId: string | undefined,
  projectIdentity: ProjectIdentity | undefined,
  scopeIdentity: ModelFacingScopeIdentity,
): RememberInput["partition"] | undefined {
  assertStableScopeIdentity(scope, scopeIdentity);
  if (scope === "local") {
    if (!projectIdentity || projectId !== projectIdentity.projectId) {
      throw new Error("local scope requires the active Pi worktree identity");
    }
    return {
      schemaVersion: 1,
      projectId,
      worktreeId: projectIdentity.worktreeId,
    };
  }
  if (scope === "user") return { schemaVersion: 1, userId: scopeIdentity.userId! };
  if (scope === "agent") return { schemaVersion: 1, agentId: scopeIdentity.agentId! };
  if (scope === "team") {
    return {
      schemaVersion: 1,
      ...(projectId === undefined ? {} : { projectId }),
      teamId: scopeIdentity.teamId!,
    };
  }
  return undefined;
}

/** Refuses identity-bearing scopes when Pi has no stable configured subject. */
function assertStableScopeIdentity(
  scope: MemoryScope,
  identity: ModelFacingScopeIdentity,
): void {
  if (scope === "user" && !identity.userId?.trim()) {
    throw new Error("user scope requires a configured stable userId");
  }
  if (scope === "agent" && !identity.agentId?.trim()) {
    throw new Error("agent scope requires a configured stable agentId");
  }
  if (scope === "team" && !identity.teamId?.trim()) {
    throw new Error("team scope requires a configured stable teamId");
  }
}

async function defaultProjectIdentity(context: PiContext): Promise<ProjectIdentity> {
  return resolveProjectIdentity(context.cwd);
}

function defaultProjectIdForScope(scope: MemoryScope, projectId: string | undefined): string | undefined {
  return scope === "project" || scope === "local" || scope === "team" ? projectId : undefined;
}

/**
 * Enforces the model-facing scope boundary. A tool argument may repeat the
 * active project id for compatibility, but it can never select another
 * project/runtime. Internal administrative APIs remain free to use explicit
 * partitions because they do not pass through this parser.
 */
function trustedProjectId(
  input: ObjectInput,
  scope: MemoryScope | undefined,
  identity: ProjectIdentity | undefined,
  defaultUnscoped = false,
): string | undefined {
  const requested = optionalString(input, "projectId");
  if (requested !== undefined && identity !== undefined && requested !== identity.projectId) {
    throw new Error("projectId must match the active Pi project");
  }
  if (requested !== undefined) return requested;
  if (scope === undefined) return defaultUnscoped ? identity?.projectId : undefined;
  return defaultProjectIdForScope(scope, identity?.projectId);
}

function success(value: unknown): PiToolResult<{ ok: true; value: unknown }> {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) ?? "null" }],
    details: { ok: true, value },
  };
}

function failure(message: string): PiToolResult<{ ok: false; error: string }> {
  return {
    content: [{ type: "text", text: `AgentEngram tool unavailable: ${message}` }],
    details: { ok: false, error: message },
  };
}
