import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncDirectory } from "../../../storage/durability.js";
import type { MemoryRecord } from "./memory-record.js";

/** Human-readable index generated beside scoped Markdown memory records. */
export const MEMORY_INDEX_NAME = "MEMORY.md";
/** Hard line limit that keeps the generated memory index model-readable. */
export const MEMORY_INDEX_MAX_LINES = 200;
/** Hard byte limit that prevents the generated index from becoming context bloat. */
export const MEMORY_INDEX_MAX_BYTES = 25_000;

/** Builds compact one-line pointers. MEMORY.md is an index, never a content store. */
export function buildMemoryIndex(records: readonly MemoryRecord[]): string {
  const active = records
    .filter(record => record.status === "active")
    .sort((a, b) => (b.importance ?? 0.5) - (a.importance ?? 0.5) || b.updatedAt.localeCompare(a.updatedAt));
  const lines: string[] = ["# Memory index", ""];
  for (const record of active) {
    const title = inline(record.name, 60);
    const hook = inline(record.description, 120);
    const line = `- [${title}](${encodeURIComponent(record.id)}.md) — ${hook}`;
    if (lines.length >= MEMORY_INDEX_MAX_LINES || byteLength([...lines, line].join("\n")) > MEMORY_INDEX_MAX_BYTES) break;
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

/** Atomic MEMORY.md projection builder for one memory scope directory. */
export class MarkdownMemoryIndex {
  /** @param directory Scope directory that owns this MEMORY.md projection. */
  public constructor(private readonly directory: string) {}

  public async read(): Promise<string> {
    try {
      return await readFile(join(this.directory, MEMORY_INDEX_NAME), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    }
  }

  public async rebuild(records: readonly MemoryRecord[]): Promise<string> {
    const content = buildMemoryIndex(records);
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, MEMORY_INDEX_NAME);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
      await syncDirectory(dirname(target));
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
    return content;
  }
}

function inline(value: string, maximum: number): string {
  const clean = value.replace(/[\r\n]+/g, " ").replace(/[\[\]()]/g, "").replace(/\s+/g, " ").trim();
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
