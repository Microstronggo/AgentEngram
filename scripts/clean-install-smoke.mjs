import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.env.AGENTENGRAM_INSTALL_SMOKE !== "1") {
  throw new Error("set AGENTENGRAM_INSTALL_SMOKE=1 to allow a network-backed clean install smoke test");
}

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "agentengram-install-"));
const packs = join(temporary, "packs");
const application = join(temporary, "application");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
// pnpm is exposed as a .cmd shim on Windows and therefore requires the command
// interpreter. Other platforms continue to execute pnpm directly.
const pnpmOptions = process.platform === "win32" ? { shell: true } : {};

try {
  mkdirSync(packs, { recursive: true });
  mkdirSync(application, { recursive: true });
  for (const name of ["engine", "mcp", "adapter-pi", "adapter-codex"]) {
    execFileSync(pnpm, ["--filter", `@agentengram/${name}`, "pack", "--pack-destination", packs], {
      cwd: root,
      stdio: "ignore",
      ...pnpmOptions,
    });
  }
  const archives = Object.fromEntries(readdirSync(packs).filter((file) => file.endsWith(".tgz")).map((file) => {
    const key = file.includes("adapter-codex") ? "codex" : file.includes("adapter-pi") ? "pi" : file.includes("engine") ? "engine" : "mcp";
    return [key, join(packs, file)];
  }));
  writeFileSync(join(application, "package.json"), `${JSON.stringify({
    name: "agentengram-clean-install-smoke",
    private: true,
    type: "module",
    packageManager: "pnpm@10.26.2",
    dependencies: {
      "@agentengram/engine": `file:${archives.engine}`,
      "@agentengram/mcp": `file:${archives.mcp}`,
      "@agentengram/adapter-pi": `file:${archives.pi}`,
      "@agentengram/adapter-codex": `file:${archives.codex}`,
    },
    pnpm: {
      onlyBuiltDependencies: ["better-sqlite3"],
      overrides: {
        "@agentengram/engine": `file:${archives.engine}`,
        "@agentengram/mcp": `file:${archives.mcp}`,
      },
    },
  }, null, 2)}\n`);
  execFileSync(pnpm, ["install", "--config.auto-install-peers=false"], {
    cwd: application,
    stdio: "inherit",
    ...pnpmOptions,
  });
  execFileSync(process.execPath, ["-e", "await Promise.all([import('@agentengram/engine'), import('@agentengram/engine/public'), import('@agentengram/engine/adapter'), import('@agentengram/engine/testing'), import('@agentengram/mcp'), import('@agentengram/adapter-pi'), import('@agentengram/adapter-codex')])"], { cwd: application });
  const cli = join(application, "node_modules", ".bin", "agentengram");
  const data = join(application, "data");
  execFileSync(cli, ["--version"], { stdio: "inherit" });
  execFileSync(cli, ["migrate", "--home", data, "--cwd", application], { stdio: "inherit" });
  execFileSync(cli, ["setup", "codex", "--home", data, "--cwd", application], { stdio: "inherit" });
  execFileSync(cli, ["config", "print", "--effective", "--redacted", "--home", data, "--cwd", application], { stdio: "inherit" });
  execFileSync(cli, ["doctor", "--adapter", "codex", "--home", data, "--cwd", application], { stdio: "inherit" });
  execFileSync(cli, ["index", "rebuild", "--home", data, "--cwd", application], { stdio: "inherit" });
  process.stdout.write("clean install smoke passed\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
