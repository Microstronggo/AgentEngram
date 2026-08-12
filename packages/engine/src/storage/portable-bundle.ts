import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type HostBinding } from "../protocol/host-identity.js";
import { AGENTENGRAM_DATA_LAYOUT_VERSION, ensureDataLayout } from "./data-layout.js";
import { FileHostBindingRepository } from "./host-binding-repository.js";
import { projectStorageRoot, storagePathSegment } from "./storage-paths.js";
import { parseMemoryMarkdown } from "../memory/long-term/records/markdown-codec.js";
import { decodeNormalizedTranscriptEntry, decodeRawTranscriptRecord } from "../transcript/transcript-codec.js";

export const AGENTENGRAM_BUNDLE_VERSION = 1 as const;
const MAX_BUNDLE_FILES = 100_000;
const MAX_BUNDLE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

/** One checksummed portable truth file. SQLite projections and lock files are never exported. */
export interface PortableBundleFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly kind: "data" | "binding";
}

/** Bundle identity used to reject unsupported or incomplete imports before writing data. */
export interface PortableBundleManifest {
  readonly product: "agentengram-portable-bundle";
  readonly schemaVersion: typeof AGENTENGRAM_BUNDLE_VERSION;
  readonly dataLayoutVersion: typeof AGENTENGRAM_DATA_LAYOUT_VERSION;
  readonly projectId: string;
  readonly includesGlobalMemory: boolean;
  readonly includesHostBindings: boolean;
  readonly createdAt: string;
  readonly files: readonly PortableBundleFile[];
}

export interface ExportPortableBundleOptions {
  readonly homeDir: string;
  readonly projectId: string;
  readonly outputDir: string;
  readonly includeGlobalMemory?: boolean;
  readonly includeHostBindings?: boolean;
}

export interface ImportPortableBundleOptions {
  readonly homeDir: string;
  readonly inputDir: string;
  readonly includeHostBindings?: boolean;
  readonly overwrite?: boolean;
}

export interface ImportPortableBundleResult {
  readonly projectId: string;
  readonly importedFiles: number;
  readonly skippedFiles: number;
  readonly importedBindings: number;
}

/**
 * Exports framework-neutral truth into a directory bundle. Rebuildable SQLite,
 * WAL/SHM files, locks, and temporary files are deliberately excluded so the
 * result remains portable across Node versions and operating systems.
 */
export async function exportPortableBundle(options: ExportPortableBundleOptions): Promise<PortableBundleManifest> {
  requireText(options.projectId, "projectId");
  const homeDir = resolve(options.homeDir);
  const outputDir = resolve(options.outputDir);
  if (inside(outputDir, homeDir)) throw new Error("bundle outputDir must be outside the AgentEngram data directory");
  await assertEmptyOrMissing(outputDir);
  await mkdir(join(outputDir, "data"), { recursive: true, mode: 0o700 });
  const files: PortableBundleFile[] = [];
  const projectRelative = relative(homeDir, projectStorageRoot(homeDir, options.projectId));
  await copyTruthTree(homeDir, projectRelative, outputDir, files);
  if (options.includeGlobalMemory) await copyTruthTree(homeDir, "global", outputDir, files);

  if (options.includeHostBindings) {
    const repository = new FileHostBindingRepository(join(homeDir, "host-bindings"));
    const bindings = (await repository.list()).filter(({ namespaceId }) => namespaceId === options.projectId);
    for (const [index, binding] of bindings.entries()) {
      const path = `bindings/${String(index).padStart(4, "0")}.json`;
      await writeAtomic(join(outputDir, path), `${JSON.stringify(binding, null, 2)}\n`);
      files.push(await describeBundleFile(outputDir, path, "binding"));
    }
  }

  const manifest: PortableBundleManifest = {
    product: "agentengram-portable-bundle",
    schemaVersion: 1,
    dataLayoutVersion: AGENTENGRAM_DATA_LAYOUT_VERSION,
    projectId: options.projectId,
    includesGlobalMemory: options.includeGlobalMemory === true,
    includesHostBindings: options.includeHostBindings === true,
    createdAt: new Date().toISOString(),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
  await writeAtomic(join(outputDir, "bundle.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Verifies every checksum before copying any portable truth into the target root. */
export async function importPortableBundle(options: ImportPortableBundleOptions): Promise<ImportPortableBundleResult> {
  const inputDir = resolve(options.inputDir);
  const homeDir = resolve(options.homeDir);
  if (inside(homeDir, inputDir) || inside(inputDir, homeDir)) {
    throw new Error("AgentEngram homeDir and bundle inputDir must not contain each other");
  }
  const manifest = decodeBundleManifest(await readFile(join(inputDir, "bundle.manifest.json"), "utf8"));
  validateBundleScope(manifest);
  await verifyBundleFiles(inputDir, manifest.files);
  await validatePortableTruth(inputDir, manifest.files);
  const importedBindingValues = options.includeHostBindings
    ? await Promise.all(manifest.files.filter(({ kind }) => kind === "binding")
        .map(async (entry) => decodeBinding(await readFile(safeBundlePath(inputDir, entry.path), "utf8"))))
    : [];
  for (const binding of importedBindingValues) {
    if (binding.namespaceId !== manifest.projectId) throw new Error("bundle binding namespace does not match projectId");
  }
  await preflightPortableTargets(homeDir, manifest.files, options.overwrite === true);
  await ensureDataLayout(homeDir);

  let importedFiles = 0;
  let skippedFiles = 0;
  let importedBindings = 0;
  for (const entry of manifest.files) {
    if (entry.kind === "binding") continue;
    const dataPath = stripPrefix(entry.path, "data/");
    const source = safeBundlePath(inputDir, entry.path);
    const target = safeBundlePath(homeDir, dataPath);
    const action = await copyPortableFile(source, target, entry.sha256, options.overwrite === true);
    if (action === "imported") importedFiles++;
    else skippedFiles++;
  }

  if (options.includeHostBindings) {
    const repository = new FileHostBindingRepository(join(homeDir, "host-bindings"));
    for (const binding of importedBindingValues) {
      await repository.save(binding);
      importedBindings++;
    }
  }
  return { projectId: manifest.projectId, importedFiles, skippedFiles, importedBindings };
}

/** Validates manifest identity and returns a normalized immutable view. */
export function decodeBundleManifest(content: string): PortableBundleManifest {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`portable bundle manifest is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || value.product !== "agentengram-portable-bundle" || value.schemaVersion !== 1) {
    throw new Error("portable bundle manifest identity is invalid");
  }
  if (value.dataLayoutVersion !== AGENTENGRAM_DATA_LAYOUT_VERSION) throw new Error("portable bundle data layout is unsupported");
  const projectId = requireText(value.projectId, "bundle projectId");
  if (typeof value.includesGlobalMemory !== "boolean" || typeof value.includesHostBindings !== "boolean") {
    throw new Error("portable bundle inclusion flags are invalid");
  }
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("portable bundle createdAt is invalid");
  }
  if (!Array.isArray(value.files) || value.files.length > MAX_BUNDLE_FILES) {
    throw new Error(`portable bundle files must contain at most ${MAX_BUNDLE_FILES} entries`);
  }
  const files = value.files.map((entry) => decodeFile(entry));
  if (files.reduce((total, entry) => total + entry.size, 0) > MAX_BUNDLE_TOTAL_BYTES) {
    throw new Error("portable bundle declared size exceeds the supported limit");
  }
  if (new Set(files.map(({ path }) => path)).size !== files.length) throw new Error("portable bundle contains duplicate paths");
  return {
    product: "agentengram-portable-bundle",
    schemaVersion: 1,
    dataLayoutVersion: 1,
    projectId,
    includesGlobalMemory: value.includesGlobalMemory,
    includesHostBindings: value.includesHostBindings,
    createdAt: value.createdAt,
    files,
  };
}

async function copyTruthTree(homeDir: string, sourceRelative: string, outputDir: string, files: PortableBundleFile[]): Promise<void> {
  const sourceRoot = safeBundlePath(homeDir, sourceRelative);
  const sourceStat = await stat(sourceRoot).catch((error: unknown) => isMissing(error) ? undefined : Promise.reject(error));
  if (!sourceStat) return;
  const paths = await walkFiles(sourceRoot);
  for (const path of paths) {
    const local = relative(homeDir, path).split(sep).join("/");
    if (!portableTruthFile(local)) continue;
    const bundlePath = `data/${local}`;
    const target = safeBundlePath(outputDir, bundlePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path, target);
    await chmod(target, 0o600);
    files.push(await describeBundleFile(outputDir, bundlePath, "data"));
  }
}

async function walkFiles(root: string): Promise<readonly string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  await visit(root);
  return output.sort();
}

function portableTruthFile(path: string): boolean {
  const name = basename(path);
  return !name.endsWith(".db") && !name.endsWith(".db-wal") && !name.endsWith(".db-shm")
    && !name.endsWith(".lock") && !name.endsWith(".tmp") && name !== ".DS_Store";
}

async function describeBundleFile(root: string, path: string, kind: PortableBundleFile["kind"]): Promise<PortableBundleFile> {
  const content = await readFile(safeBundlePath(root, path));
  return { path, size: content.byteLength, sha256: sha256(content), kind };
}

async function verifyBundleFiles(root: string, files: readonly PortableBundleFile[]): Promise<void> {
  for (const entry of files) {
    const path = safeBundlePath(root, entry.path);
    await assertNoSymlinkComponents(root, entry.path);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`portable bundle entry is not a regular file: ${entry.path}`);
    const content = await readFile(path);
    if (content.byteLength !== entry.size || sha256(content) !== entry.sha256) {
      throw new Error(`portable bundle checksum mismatch: ${entry.path}`);
    }
  }
}

async function copyPortableFile(source: string, target: string, expectedHash: string, overwrite: boolean): Promise<"imported" | "skipped"> {
  const existing = await readFile(target).catch((error: unknown) => isMissing(error) ? undefined : Promise.reject(error));
  if (existing && sha256(existing) === expectedHash) return "skipped";
  if (existing && !overwrite) throw new Error(`portable import would overwrite different truth: ${target}`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(dirname(target), basename(target), true);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await copyFile(source, temporary);
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  return "imported";
}

async function preflightPortableTargets(
  homeDir: string,
  files: readonly PortableBundleFile[],
  overwrite: boolean,
): Promise<void> {
  for (const entry of files) {
    if (entry.kind !== "data") continue;
    const dataPath = stripPrefix(entry.path, "data/");
    const target = safeBundlePath(homeDir, dataPath);
    await assertNoSymlinkComponents(homeDir, dataPath, true);
    const existing = await readFile(target).catch((error: unknown) => isMissing(error) ? undefined : Promise.reject(error));
    if (!existing || sha256(existing) === entry.sha256 || overwrite) continue;
    throw new Error(`portable import would overwrite different truth: ${target}`);
  }
}

async function assertEmptyOrMissing(path: string): Promise<void> {
  const entries = await readdir(path).catch((error: unknown) => isMissing(error) ? undefined : Promise.reject(error));
  if (entries && entries.length > 0) throw new Error(`bundle outputDir must be empty: ${path}`);
  if (entries) await rm(path, { recursive: true, force: true });
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

function decodeFile(value: unknown): PortableBundleFile {
  if (!isRecord(value)) throw new Error("portable bundle file entry must be an object");
  const path = requireSafeRelativePath(value.path, "bundle file path");
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0 || (value.size as number) > MAX_BUNDLE_FILE_BYTES) {
    throw new Error("portable bundle file size is invalid or exceeds the supported limit");
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("portable bundle sha256 is invalid");
  if (value.kind !== "data" && value.kind !== "binding") throw new Error("portable bundle file kind is invalid");
  if (value.kind === "data" && !path.startsWith("data/")) throw new Error("portable data path must start with data/");
  if (value.kind === "binding" && !path.startsWith("bindings/")) throw new Error("portable binding path must start with bindings/");
  return { path, size: value.size as number, sha256: value.sha256, kind: value.kind };
}

function validateBundleScope(manifest: PortableBundleManifest): void {
  const projectPrefix = `data/projects/${storagePathSegment(manifest.projectId)}/`;
  for (const entry of manifest.files) {
    if (entry.kind === "binding") continue;
    const allowedProject = entry.path.startsWith(projectPrefix);
    const allowedGlobal = manifest.includesGlobalMemory && entry.path.startsWith("data/global/");
    if (!allowedProject && !allowedGlobal) {
      throw new Error(`portable bundle data path is outside its declared scope: ${entry.path}`);
    }
  }
}

function decodeBinding(content: string): HostBinding {
  const value = JSON.parse(content) as unknown;
  if (!isRecord(value) || !isRecord(value.identity)) throw new Error("portable binding is invalid");
  const identity = value.identity;
  for (const field of ["hostType", "hostProjectId", "hostSessionId", "hostThreadId"] as const) {
    requireText(identity[field], `binding ${field}`);
  }
  return value as unknown as HostBinding;
}

function safeBundlePath(root: string, path: string): string {
  const normalized = requireSafeRelativePath(path.split(sep).join("/"), "portable path");
  return resolve(root, ...normalized.split("/"));
}

/** Rejects symlink components so a valid relative manifest cannot escape through filesystem indirection. */
async function assertNoSymlinkComponents(root: string, path: string, allowMissing = false): Promise<void> {
  const normalized = requireSafeRelativePath(path.split(sep).join("/"), "portable path");
  let current = resolve(root);
  for (const part of normalized.split("/")) {
    current = join(current, part);
    const metadata = await lstat(current).catch((error: unknown) => isMissing(error) ? undefined : Promise.reject(error));
    if (!metadata) {
      if (allowMissing) return;
      throw new Error(`portable bundle entry is missing: ${path}`);
    }
    if (metadata.isSymbolicLink()) throw new Error(`portable path contains a symbolic link: ${path}`);
  }
}

/** Validates transcript and Markdown truth before any target file is written. */
async function validatePortableTruth(root: string, files: readonly PortableBundleFile[]): Promise<void> {
  for (const entry of files) {
    if (entry.kind !== "data") continue;
    const content = await readFile(safeBundlePath(root, entry.path), "utf8");
    if (entry.path.endsWith("/raw.jsonl") || entry.path.endsWith("/normalized.jsonl")) {
      if (content.length > 0 && !content.endsWith("\n")) throw new Error(`portable transcript is missing a terminal newline: ${entry.path}`);
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        if (entry.path.endsWith("/raw.jsonl")) decodeRawTranscriptRecord(line);
        else decodeNormalizedTranscriptEntry(line);
      }
    } else if (entry.path.endsWith(".md") && !entry.path.endsWith("/MEMORY.md")) {
      parseMemoryMarkdown(content);
    }
  }
}

function requireSafeRelativePath(value: unknown, name: string): string {
  const path = requireText(value, name).replaceAll("\\", "/");
  if (isAbsolute(path) || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${name} must be a safe relative path`);
  }
  return path;
}

function stripPrefix(value: string, prefix: string): string {
  if (!value.startsWith(prefix)) throw new Error(`portable path must start with ${prefix}`);
  return value.slice(prefix.length);
}

function inside(candidate: string, root: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..");
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
