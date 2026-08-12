import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHostBinding, type HostBinding, type HostIdentity } from "../protocol/host-identity.js";

/** Exact host key required to find one portable namespace/thread binding. */
export type HostBindingLookup = Pick<
  HostIdentity,
  "hostType" | "hostProjectId" | "hostSessionId" | "hostThreadId"
>;

/** Durable binding operations intentionally omit fuzzy or cross-session lookup. */
export interface HostBindingRepository {
  load(lookup: HostBindingLookup): Promise<HostBinding | undefined>;
  list(): Promise<readonly HostBinding[]>;
  save(binding: HostBinding): Promise<void>;
  remove(lookup: HostBindingLookup): Promise<void>;
}

/**
 * Atomic local HostBinding repository keyed by every host identity dimension.
 * Exact lookup prevents unrelated sessions from being merged by inference.
 */
export class FileHostBindingRepository implements HostBindingRepository {
  public constructor(private readonly rootDir: string) {
    if (!rootDir.trim()) throw new Error("host binding rootDir is required");
  }

  /** Returns only an exact hostType/project/session/thread binding. */
  public async load(lookup: HostBindingLookup): Promise<HostBinding | undefined> {
    validateLookup(lookup);
    let content: string;
    try {
      content = await readFile(this.pathFor(lookup), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    const binding = decodeBinding(content);
    if (!sameLookup(binding.identity, lookup)) throw new Error("host binding identity does not match requested lookup");
    return binding;
  }

  /** Lists validated bindings for administration, export, and explicit rebinding. */
  public async list(): Promise<readonly HostBinding[]> {
    const names = await readdir(this.rootDir).catch((error: unknown) => {
      if (isMissingFile(error)) return [];
      throw error;
    });
    const bindings: HostBinding[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      bindings.push(decodeBinding(await readFile(join(this.rootDir, name), "utf8")));
    }
    return bindings.sort((left, right) => canonicalLookup(left.identity).localeCompare(canonicalLookup(right.identity)));
  }

  /** Fsyncs the full binding before publishing it with atomic rename. */
  public async save(binding: HostBinding): Promise<void> {
    const normalized = normalizeBinding(binding);
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const target = this.pathFor(normalized.identity);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(normalized)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      const directory = await open(this.rootDir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /** Removes an exact mapping without deleting namespace data or transcript. */
  public async remove(lookup: HostBindingLookup): Promise<void> {
    validateLookup(lookup);
    await unlink(this.pathFor(lookup)).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }

  private pathFor(lookup: HostBindingLookup): string {
    const digest = createHash("sha256").update(canonicalLookup(lookup)).digest("hex");
    return join(this.rootDir, `${digest}.json`);
  }
}

function decodeBinding(content: string): HostBinding {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`host binding is not valid JSON: ${errorMessage(error)}`);
  }
  return normalizeBinding(value);
}

function normalizeBinding(value: unknown): HostBinding {
  if (!isRecord(value) || !isRecord(value.identity)) throw new Error("host binding must be an object");
  const identity = value.identity as unknown as HostIdentity;
  // Reuse the public constructor so untrusted disk fields are type-checked and
  // canonical whitespace never changes the exact-lookup storage key.
  return createHostBinding(identity, {
    namespaceId: typeof value.namespaceId === "string" ? value.namespaceId : "",
    threadId: typeof value.threadId === "string" ? value.threadId : "",
  });
}

function validateLookup(lookup: HostBindingLookup): void {
  createHostBinding({ ...lookup }, { namespaceId: lookup.hostProjectId, threadId: lookup.hostThreadId });
}

function canonicalLookup(lookup: HostBindingLookup): string {
  const normalized = createHostBinding(lookup).identity;
  return JSON.stringify([
    normalized.hostType,
    normalized.hostProjectId,
    normalized.hostSessionId,
    normalized.hostThreadId,
  ]);
}

function sameLookup(identity: HostIdentity, lookup: HostBindingLookup): boolean {
  return identity.hostType === lookup.hostType
    && identity.hostProjectId === lookup.hostProjectId
    && identity.hostSessionId === lookup.hostSessionId
    && identity.hostThreadId === lookup.hostThreadId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
