import { createHash } from "node:crypto";
import { join } from "node:path";

/** Converts an external identity to the collision-safe segment used on disk. */
export function storagePathSegment(value: string): string {
  if (value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value)) return value;
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** Stable project root shared by adapters, workers, admin tools, and Engine. */
export function projectStorageRoot(homeDir: string, projectId: string): string {
  return join(homeDir, "projects", storagePathSegment(projectId));
}

/** Project-local durable background runtime directory. */
export function projectRuntimeRoot(homeDir: string, projectId: string): string {
  return join(projectStorageRoot(homeDir, projectId), "runtime");
}
