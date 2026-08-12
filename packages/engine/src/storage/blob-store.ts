import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Integrity-checked reference to content moved out of transcript JSONL rows. */
export interface BlobReference {
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

/** Content-addressed durable storage for large canonical tool results. */
export class BlobStore {
  /** @param rootDir Private content-addressed blob root. */
  constructor(private readonly rootDir: string) {}

  /** Writes content atomically and returns its SHA-256 address. */
  async put(value: Uint8Array | string, mediaType = "text/plain; charset=utf-8"): Promise<BlobReference> {
    const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const target = this.pathFor(digest);
    await mkdir(dirname(target), { recursive: true });
    // Write, fsync, and atomically rename so a crash cannot expose partial content.
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      await rename(temporary, target).catch(async (error: unknown) => {
        if (isNodeError(error) && error.code === "EEXIST") await rm(temporary, { force: true });
        else throw error;
      });
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
    return { algorithm: "sha256", digest, byteLength: bytes.byteLength, mediaType };
  }

  /** Loads a blob only after its bytes match the referenced digest. */
  async get(reference: BlobReference): Promise<Buffer> {
    if (reference.algorithm !== "sha256" || !/^[a-f0-9]{64}$/.test(reference.digest)) {
      throw new Error("invalid blob reference");
    }
    const bytes = await readFile(this.pathFor(reference.digest));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== reference.digest) throw new Error("blob digest mismatch");
    return bytes;
  }

  /** Removes content-addressed files not referenced by any remaining project truth. */
  async prune(referencedDigests: ReadonlySet<string>): Promise<number> {
    let removed = 0;
    for (const prefix of await readdir(this.rootDir, { withFileTypes: true }).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    })) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const directory = join(this.rootDir, prefix.name);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const digest = `${prefix.name}${entry.name}`;
        if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(digest) || referencedDigests.has(digest)) continue;
        await rm(join(directory, entry.name), { force: true });
        removed++;
      }
      await rmdir(directory).catch((error: unknown) => {
        if (!isNodeError(error) || (error.code !== "ENOTEMPTY" && error.code !== "ENOENT")) throw error;
      });
    }
    return removed;
  }

  private pathFor(digest: string): string {
    return join(this.rootDir, digest.slice(0, 2), digest.slice(2));
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
