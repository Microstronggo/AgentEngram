import { createHash } from "node:crypto";
import { createMemoryPartition, type MemoryPartition } from "./memory-partition.js";

/** Product-level origins that control memory handling and presentation. */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
/** Product-level origin of a durable memory. */
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Cognitive classes used by extraction, hierarchy expansion, and recall. */
export const MEMORY_CLASSES = ["factual", "episodic", "procedural", "semantic"] as const;
/** Cognitive class used by typed extraction and recall. */
export type MemoryClass = (typeof MEMORY_CLASSES)[number];

/** Operational subtypes used for targeted extraction, maintenance, and recall. */
export const MEMORY_KINDS = [
  "preference",
  "correction",
  "decision",
  "convention",
  "failure",
  "insight",
  "tool-quirk",
] as const;
/** Operational subtype that refines a record's cognitive memory class. */
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Isolation scopes accepted by Markdown storage and search filters. */
export const MEMORY_SCOPES = ["user", "project", "local", "agent", "team"] as const;
/** Isolation boundary applied to storage and recall. */
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** Lifecycle states that preserve history instead of destructively overwriting it. */
export const MEMORY_STATUSES = ["active", "superseded", "archived"] as const;
/** Non-destructive lifecycle state of a durable memory. */
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** Directed relation extracted from durable memory text for lightweight rerank and explanation. */
export interface MemoryRelation {
  /** Entity or concept that owns the relation; often a user, project, or domain object. */
  readonly subject: string;
  /** Normalized relation verb such as `uses`, `attended`, or `interested_in`. */
  readonly predicate: string;
  /** Entity, concept, or event on the other side of the relation. */
  readonly object: string;
}

/** Durable long-term memory record; Markdown remains the truth source and FTS rows are projections. */
export interface MemoryRecord {
  id: string;
  name: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  content: string;
  tags: string[];
  schemaVersion: 1;
  /** Monotonic optimistic-concurrency revision; legacy records are read as revision 1. */
  revision: number;
  /** Stable hash used for exact duplicate detection without relying on generated ids. */
  contentHash: string;
  /** Full storage identity; scope remains the visibility policy. */
  partition: MemoryPartition;
  /** Actor that directly asserted or extracted this record. */
  assertedBy?: "user" | "agent" | "system" | "extractor";
  /** Distinguishes direct assertions from inference and explicit correction. */
  epistemicStatus?: "asserted" | "inferred" | "corrected";
  kind?: MemoryKind;
  memoryClass?: MemoryClass;
  sourceRefs: string[];
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  validFrom?: string;
  supersedes?: string;
  validUntil?: string;
  confidence?: number;
  importance?: number;
  projectId?: string;
  /** Optional extracted names/concepts. Stored for provenance and future rerank, not blindly indexed. */
  entities?: readonly string[];
  /** Absolute event date when the memory describes a dated event. */
  eventDate?: string;
  /** Normalized event interval used by temporal recall; eventDate remains a compatibility alias. */
  eventStart?: string;
  eventEnd?: string;
  timePrecision?: "year" | "month" | "day" | "time" | "approximate";
  /** Relative temporal phrase found in source text, e.g. `yesterday` or `last week`. */
  relativeDate?: string;
  /** Optional relation triples used as low-weight discriminative recall metadata. */
  relations?: readonly MemoryRelation[];
  /** Parent durable memory ids when this record was derived from an episode or another memory. */
  parentMemoryIds?: readonly string[];
}

/** Creation input before schema defaults, normalization, and class inference. */
export type NewMemoryRecord = Omit<
  MemoryRecord,
  "schemaVersion" | "revision" | "contentHash" | "partition" | "sourceRefs" | "tags" | "status" | "createdAt" | "updatedAt"
> &
  Partial<Pick<MemoryRecord, "revision" | "contentHash" | "partition" | "sourceRefs" | "tags" | "status" | "createdAt" | "updatedAt">>;

/** Validates and normalizes a record before it becomes Markdown truth. */
export function createMemoryRecord(input: NewMemoryRecord, now = new Date()): MemoryRecord {
  const timestamp = now.toISOString();
  const confidence = normalizeUnitInterval(input.confidence, "confidence");
  const importance = normalizeUnitInterval(input.importance, "importance");
  const memoryClass = inferMemoryClass(input);
  const entities = normalizeStringList(input.entities);
  const relations = normalizeRelations(input.relations);
  const parentMemoryIds = normalizeStringList(input.parentMemoryIds);
  const partition = input.partition ?? createMemoryPartition(input.scope, {
    ...(input.projectId ? { projectId: input.projectId } : {}),
  });
  // Strip fields that are normalized below so empty arrays and untrimmed values
  // cannot leak back through the final spread under exactOptionalPropertyTypes.
  const {
    name: _name,
    description: _description,
    content: _content,
    sourceRefs: _sourceRefs,
    tags: _tags,
    status: _status,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    memoryClass: _memoryClass,
    entities: _entities,
    eventDate: _eventDate,
    relativeDate: _relativeDate,
    relations: _relations,
    parentMemoryIds: _parentMemoryIds,
    confidence: _confidence,
    importance: _importance,
    revision: _revision,
    contentHash: _contentHash,
    partition: _partition,
    ...stableFields
  } = input;

  return {
    ...stableFields,
    name: requireText(input.name, "name"),
    description: requireText(input.description, "description"),
    content: requireText(input.content, "content"),
    schemaVersion: 1,
    revision: normalizeRevision(input.revision),
    contentHash: input.contentHash ?? hashMemoryContent(input.content),
    partition,
    sourceRefs: input.sourceRefs ?? [],
    tags: [...new Set((input.tags ?? []).map(tag => tag.trim()).filter(Boolean))],
    status: input.status ?? "active",
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    memoryClass,
    ...(entities.length === 0 ? {} : { entities }),
    ...(input.eventDate?.trim() ? { eventDate: input.eventDate.trim() } : {}),
    ...(input.relativeDate?.trim() ? { relativeDate: input.relativeDate.trim() } : {}),
    ...(relations.length === 0 ? {} : { relations }),
    ...(parentMemoryIds.length === 0 ? {} : { parentMemoryIds }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(importance === undefined ? {} : { importance }),
  };
}

/** Hashes normalized semantic content for exact duplicate and idempotency checks. */
export function hashMemoryContent(content: string): string {
  return createHash("sha256").update(content.toLowerCase().replace(/\s+/gu, " ").trim()).digest("hex");
}

function normalizeRevision(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("revision must be a positive integer");
  return value;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

function normalizeUnitInterval(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
  return value;
}

function normalizeStringList(values: readonly string[] | undefined): readonly string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalizeRelations(values: readonly MemoryRelation[] | undefined): readonly MemoryRelation[] {
  // Invalid partial triples are ignored instead of being persisted as durable
  // memory metadata; the source text remains available through sourceRefs.
  return (values ?? []).flatMap((relation) => {
    const subject = relation.subject.trim();
    const predicate = relation.predicate.trim();
    const object = relation.object.trim();
    return subject && predicate && object ? [{ subject, predicate, object }] : [];
  });
}

/** Runtime guard for MemoryType frontmatter values. */
export function isMemoryType(value: string): value is MemoryType {
  return MEMORY_TYPES.some((type) => type === value);
}

/** Runtime guard for MemoryKind frontmatter values. */
export function isMemoryKind(value: string): value is MemoryKind {
  return MEMORY_KINDS.some((kind) => kind === value);
}

/** Runtime guard for MemoryClass frontmatter values. */
export function isMemoryClass(value: string): value is MemoryClass {
  return MEMORY_CLASSES.some((memoryClass) => memoryClass === value);
}

/** Runtime guard for MemoryScope frontmatter values. */
export function isMemoryScope(value: string): value is MemoryScope {
  return MEMORY_SCOPES.some((scope) => scope === value);
}

/** Runtime guard for MemoryStatus frontmatter values. */
export function isMemoryStatus(value: string): value is MemoryStatus {
  return MEMORY_STATUSES.some((status) => status === value);
}

/** Returns a stable class for old records that predate the memoryClass field. */
export function inferMemoryClass(value: { readonly memoryClass?: MemoryClass; readonly kind?: MemoryKind; readonly type?: MemoryType }): MemoryClass {
  if (value.memoryClass) return value.memoryClass;
  switch (value.kind) {
    case "preference":
    case "decision":
      return "factual";
    case "correction":
    case "convention":
    case "tool-quirk":
      return "procedural";
    case "failure":
      return "episodic";
    case "insight":
      return "semantic";
    default:
      return value.type === "reference" ? "semantic" : "factual";
  }
}
