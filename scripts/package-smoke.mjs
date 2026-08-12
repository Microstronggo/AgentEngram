import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = mkdtempSync(join(tmpdir(), "agentengram-pack-"));
const packages = ["engine", "mcp", "adapter-pi", "adapter-codex"];
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
// Windows command shims are batch files, so Node must invoke them through the
// command interpreter. POSIX keeps direct execution to avoid shell expansion.
const pnpmOptions = process.platform === "win32" ? { shell: true } : {};

try {
  for (const name of packages) {
    execFileSync(pnpm, ["--filter", `@agentengram/${name}`, "pack", "--pack-destination", output], {
      cwd: root,
      stdio: "ignore",
      ...pnpmOptions,
    });
  }
  const archives = readdirSync(output).filter((file) => file.endsWith(".tgz"));
  if (archives.length !== packages.length) throw new Error(`expected ${packages.length} archives, found ${archives.length}`);
  for (const archive of archives) validateArchive(join(output, archive));
  process.stdout.write(`package smoke passed: ${archives.sort().join(", ")}\n`);
} finally {
  rmSync(output, { recursive: true, force: true });
}

function validateArchive(path) {
  const listing = execFileSync("tar", ["-tzf", path], { encoding: "utf8" }).trim().split("\n");
  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", path, "package/package.json"], { encoding: "utf8" }));
  const required = [manifest.main, manifest.types, ...Object.values(manifest.bin ?? {})]
    .map((entry) => `package/${String(entry).replace(/^\.\//, "")}`);
  required.push("package/README.md", "package/LICENSE");
  for (const entry of required) if (!listing.includes(entry)) throw new Error(`${basename(path)} is missing ${entry}`);
  if (manifest.license !== "Apache-2.0") throw new Error(`${manifest.name} must declare Apache-2.0`);
  if (manifest.repository?.url !== "git+https://github.com/Microstronggo/AgentEngram.git") {
    throw new Error(`${manifest.name} has incorrect repository metadata`);
  }
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (String(version).startsWith("workspace:")) throw new Error(`${manifest.name} did not rewrite workspace dependency ${name}`);
  }
  if (manifest.name === "@agentengram/engine" && manifest.bin?.agentengram !== "./dist/cli.js") {
    throw new Error("engine package is missing the agentengram admin CLI");
  }
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (!target || typeof target !== "object") continue;
    for (const field of ["types", "import"]) {
      const value = target[field];
      if (value && !listing.includes(`package/${String(value).replace(/^\.\//, "")}`)) {
        throw new Error(`${manifest.name} export ${subpath} is missing ${field} target ${value}`);
      }
    }
  }
}
