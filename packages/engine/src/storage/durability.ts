import { open } from "node:fs/promises";

/**
 * Flushes a renamed directory entry when the platform supports directory fsync.
 *
 * Windows rejects fsync on directory handles with EPERM. Atomic writers still
 * fsync the temporary file before rename there, but must skip this additional
 * POSIX durability barrier so otherwise valid writes remain portable.
 */
export async function syncDirectory(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
