import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BlobStore } from "./blob-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it("stores canonical tool output by content digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentengram-blobs-"));
  roots.push(root);
  const store = new BlobStore(root);
  const first = await store.put("large tool result");
  const second = await store.put("large tool result");
  expect(second.digest).toBe(first.digest);
  expect((await store.get(first)).toString("utf8")).toBe("large tool result");
  const retained = await store.put("still referenced");
  await expect(store.prune(new Set([retained.digest]))).resolves.toBe(1);
  await expect(store.get(first)).rejects.toThrow();
  await expect(store.get(retained)).resolves.toBeDefined();
});
