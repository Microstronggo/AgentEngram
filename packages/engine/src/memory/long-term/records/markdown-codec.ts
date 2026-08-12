import {
  createMemoryRecord,
  inferMemoryClass,
  isMemoryClass,
  isMemoryKind,
  isMemoryScope,
  isMemoryStatus,
  isMemoryType,
  type MemoryRelation,
  type MemoryRecord,
} from "./memory-record.js";
import { createMemoryPartition } from "./memory-partition.js";

const FRONTMATTER_DELIMITER = "---";

/** Serializes a durable memory record into the portable Markdown truth format. */
export function serializeMemoryMarkdown(record: MemoryRecord): string {
  // Normalize records supplied by older adapters before emitting the additive
  // partition/revision fields introduced by the P0 write model.
  record = createMemoryRecord(record);
  const lines = [
    FRONTMATTER_DELIMITER,
    `id: ${scalar(record.id)}`,
    `name: ${scalar(record.name)}`,
    `description: ${scalar(record.description)}`,
    `type: ${record.type}`,
    `scope: ${record.scope}`,
  ];

  if (record.kind) lines.push(`kind: ${record.kind}`);
  lines.push(`memory_class: ${inferMemoryClass(record)}`);
  lines.push(`created_at: ${record.createdAt}`);
  lines.push(`updated_at: ${record.updatedAt}`);
  lines.push(`status: ${record.status}`);
  lines.push(`schema_version: ${record.schemaVersion}`);
  lines.push(`revision: ${record.revision}`);
  lines.push(`content_hash: ${record.contentHash}`);
  if (record.projectId) lines.push(`project_id: ${scalar(record.projectId)}`);
  lines.push(`partition_json: ${scalar(JSON.stringify(record.partition))}`);
  if (record.assertedBy) lines.push(`asserted_by: ${record.assertedBy}`);
  if (record.epistemicStatus) lines.push(`epistemic_status: ${record.epistemicStatus}`);
  if (record.supersedes) lines.push(`supersedes: ${scalar(record.supersedes)}`);
  if (record.validUntil) lines.push(`valid_until: ${record.validUntil}`);
  if (record.confidence !== undefined) lines.push(`confidence: ${record.confidence}`);
  if (record.importance !== undefined) lines.push(`importance: ${record.importance}`);
  if (record.lastAccessedAt) lines.push(`last_accessed_at: ${record.lastAccessedAt}`);
  if (record.validFrom) lines.push(`valid_from: ${record.validFrom}`);
  if (record.eventDate) lines.push(`event_date: ${scalar(record.eventDate)}`);
  if (record.eventStart) lines.push(`event_start: ${scalar(record.eventStart)}`);
  if (record.eventEnd) lines.push(`event_end: ${scalar(record.eventEnd)}`);
  if (record.timePrecision) lines.push(`time_precision: ${record.timePrecision}`);
  if (record.relativeDate) lines.push(`relative_date: ${scalar(record.relativeDate)}`);
  // Relations stay JSON-encoded inside frontmatter to avoid inventing nested
  // YAML parsing rules in this intentionally small codec.
  if (record.relations?.length) lines.push(`relations_json: ${scalar(JSON.stringify(record.relations))}`);
  lines.push("tags:");
  for (const tag of record.tags) lines.push(`  - ${scalar(tag)}`);
  if (record.parentMemoryIds?.length) {
    // Parent links are portable memory-to-memory provenance. Transcript/tool
    // evidence remains independently recorded under source_refs.
    lines.push("parent_memory_ids:");
    for (const parentId of record.parentMemoryIds) lines.push(`  - ${scalar(parentId)}`);
  }
  if (record.entities?.length) {
    lines.push("entities:");
    for (const entity of record.entities) lines.push(`  - ${scalar(entity)}`);
  }
  lines.push("source_refs:");
  for (const sourceRef of record.sourceRefs) lines.push(`  - ${scalar(sourceRef)}`);
  lines.push(FRONTMATTER_DELIMITER, "", record.content.trim(), "");
  return lines.join("\n");
}

/** Parses the portable Markdown truth format back into a normalized memory record. */
export function parseMemoryMarkdown(markdown: string): MemoryRecord {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== FRONTMATTER_DELIMITER) throw new Error("memory frontmatter is missing");
  const end = lines.indexOf(FRONTMATTER_DELIMITER, 1);
  if (end < 0) throw new Error("memory frontmatter is not closed");
  const manifestHeader = lines.slice(1, Math.min(end, 30)).join("\n");
  // Keep core manifest fields near the top so MEMORY.md and humans can inspect
  // large memory files without scanning arbitrary-length content.
  for (const key of ["name", "description", "type", "scope", "schema_version"]) {
    if (!new RegExp(`^${key}:`, "m").test(manifestHeader)) {
      throw new Error(`memory manifest field must appear within first 30 lines: ${key}`);
    }
  }

  const fields = new Map<string, string>();
  const sourceRefs: string[] = [];
  const tags: string[] = [];
  const entities: string[] = [];
  const parentMemoryIds: string[] = [];
  let readingList: "source_refs" | "tags" | "entities" | "parent_memory_ids" | null = null;
  for (const line of lines.slice(1, end)) {
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (readingList && listItem?.[1]) {
      (readingList === "source_refs"
        ? sourceRefs
        : readingList === "tags"
          ? tags
          : readingList === "entities"
            ? entities
            : parentMemoryIds).push(unquote(listItem[1]));
      continue;
    }
    const match = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!match?.[1]) continue;
    // This parser intentionally supports only the small list syntax emitted by
    // serializeMemoryMarkdown; unknown nested structures are ignored.
    readingList = match[1] === "source_refs" || match[1] === "tags" || match[1] === "entities" || match[1] === "parent_memory_ids"
      ? match[1]
      : null;
    if (!readingList) fields.set(match[1], unquote(match[2] ?? ""));
  }

  const type = required(fields, "type");
  const scope = required(fields, "scope");
  const kind = fields.get("kind");
  const memoryClass = fields.get("memory_class");
  const status = fields.get("status") ?? "active";
  if (!isMemoryType(type)) throw new Error(`unknown memory type: ${type}`);
  if (!isMemoryScope(scope)) throw new Error(`unknown memory scope: ${scope}`);
  if (kind && !isMemoryKind(kind)) throw new Error(`unknown memory kind: ${kind}`);
  if (memoryClass && !isMemoryClass(memoryClass)) throw new Error(`unknown memory class: ${memoryClass}`);
  if (!isMemoryStatus(status)) throw new Error(`unknown memory status: ${status}`);
  if (fields.get("schema_version") !== "1") throw new Error("unsupported memory schema version");

  const optionalNumber = (key: string): number | undefined => {
    const value = fields.get(key);
    return value === undefined ? undefined : Number(value);
  };
  const confidence = optionalNumber("confidence");
  const importance = optionalNumber("importance");
  const relations = parseRelations(fields.get("relations_json"));
  const projectId = fields.get("project_id");
  const partition = parsePartition(fields.get("partition_json"), scope, projectId);

  return createMemoryRecord({
    id: required(fields, "id"),
    name: required(fields, "name"),
    description: required(fields, "description"),
    type,
    scope,
    content: lines.slice(end + 1).join("\n").trim(),
    sourceRefs,
    tags,
    entities,
    parentMemoryIds,
    status,
    createdAt: required(fields, "created_at"),
    updatedAt: required(fields, "updated_at"),
    ...(fields.has("revision") ? { revision: optionalNumber("revision")! } : {}),
    ...(fields.has("content_hash") ? { contentHash: required(fields, "content_hash") } : {}),
    partition,
    ...(kind && isMemoryKind(kind) ? { kind } : {}),
    ...(memoryClass && isMemoryClass(memoryClass) ? { memoryClass } : {}),
    ...(projectId ? { projectId } : {}),
    ...(fields.has("asserted_by") ? { assertedBy: parseAssertedBy(required(fields, "asserted_by")) } : {}),
    ...(fields.has("epistemic_status") ? { epistemicStatus: parseEpistemicStatus(required(fields, "epistemic_status")) } : {}),
    ...(fields.has("supersedes") ? { supersedes: required(fields, "supersedes") } : {}),
    ...(fields.has("valid_until") ? { validUntil: required(fields, "valid_until") } : {}),
    ...(fields.has("valid_from") ? { validFrom: required(fields, "valid_from") } : {}),
    ...(fields.has("last_accessed_at") ? { lastAccessedAt: required(fields, "last_accessed_at") } : {}),
    ...(fields.has("event_date") ? { eventDate: required(fields, "event_date") } : {}),
    ...(fields.has("event_start") ? { eventStart: required(fields, "event_start") } : {}),
    ...(fields.has("event_end") ? { eventEnd: required(fields, "event_end") } : {}),
    ...(fields.has("time_precision") ? { timePrecision: parseTimePrecision(required(fields, "time_precision")) } : {}),
    ...(fields.has("relative_date") ? { relativeDate: required(fields, "relative_date") } : {}),
    ...(relations.length === 0 ? {} : { relations }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(importance === undefined ? {} : { importance }),
  });
}

function parsePartition(value: string | undefined, scope: MemoryRecord["scope"], projectId?: string) {
  if (!value) return createMemoryPartition(scope, projectId ? { projectId } : {});
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid memory partition");
  const fields = parsed as Record<string, unknown>;
  if (fields.schemaVersion !== 1) throw new Error("unsupported memory partition schema version");
  return createMemoryPartition(scope, {
    ...stringField(fields, "appId"),
    ...stringField(fields, "userId"),
    ...stringField(fields, "agentId"),
    ...stringField(fields, "teamId"),
    ...stringField(fields, "projectId"),
    ...stringField(fields, "worktreeId"),
    ...stringField(fields, "namespace"),
  });
}

function stringField(value: Record<string, unknown>, key: string): Record<string, string> {
  return typeof value[key] === "string" ? { [key]: value[key] } : {};
}

function parseAssertedBy(value: string): NonNullable<MemoryRecord["assertedBy"]> {
  if (value === "user" || value === "agent" || value === "system" || value === "extractor") return value;
  throw new Error(`unknown asserted_by: ${value}`);
}

function parseEpistemicStatus(value: string): NonNullable<MemoryRecord["epistemicStatus"]> {
  if (value === "asserted" || value === "inferred" || value === "corrected") return value;
  throw new Error(`unknown epistemic_status: ${value}`);
}

function parseTimePrecision(value: string): NonNullable<MemoryRecord["timePrecision"]> {
  if (value === "year" || value === "month" || value === "day" || value === "time" || value === "approximate") return value;
  throw new Error(`unknown time_precision: ${value}`);
}

function scalar(value: string): string {
  return JSON.stringify(value);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed) as string;
  }
  return trimmed;
}

function required(fields: Map<string, string>, key: string): string {
  const value = fields.get(key)?.trim();
  if (!value) throw new Error(`missing memory field: ${key}`);
  return value;
}

function parseRelations(value: string | undefined): readonly MemoryRelation[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      // Fail closed on malformed relation entries; durable memory content and
      // sourceRefs are still preserved even when optional metadata is dropped.
      if (!item || typeof item !== "object") return [];
      const relation = item as Record<string, unknown>;
      return typeof relation.subject === "string" &&
        typeof relation.predicate === "string" &&
        typeof relation.object === "string"
        ? [{ subject: relation.subject, predicate: relation.predicate, object: relation.object }]
        : [];
    });
  } catch {
    return [];
  }
}
