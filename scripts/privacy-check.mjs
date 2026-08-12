import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname } from "node:path";

const root = new URL("..", import.meta.url);
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
}).trim().split("\n").filter(Boolean);
const home = homedir();
const account = basename(home);
const excludedPrefixes = [
  "packages/evaluation/datasets/",
  "packages/evaluation/reports/",
];
const binaryExtensions = new Set([".db", ".png", ".jpg", ".jpeg", ".gif", ".zip", ".tgz", ".pdf"]);
const checks = [
  { name: "local home path", pattern: home },
  { name: "local account name", pattern: account },
  { name: "absolute macOS user path", regex: /\/Users\/[^/\s`"']+/g },
  { name: "absolute Windows user path", regex: /[A-Za-z]:\\Users\\[^\\\s`"']+/g },
  { name: "private key", regex: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/g },
  { name: "probable API token", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
];
const failures = [];
let inspectedFiles = 0;

for (const file of files) {
  if (excludedPrefixes.some((prefix) => file.startsWith(prefix)) || binaryExtensions.has(extname(file).toLowerCase())) continue;
  const path = new URL(file, root);
  // `git ls-files --cached` also reports tracked paths that are deleted in the
  // working tree. Release checks must remain usable before those deletions are
  // staged or committed, so treat a missing path as absent from the public tree.
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile()) continue;
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  inspectedFiles += 1;
  for (const check of checks) {
    const matches = check.pattern
      ? content.includes(check.pattern) ? [check.pattern] : []
      : [...content.matchAll(check.regex)].map((match) => match[0]);
    if (matches.length > 0) failures.push(`${file}: ${check.name} (${[...new Set(matches)].join(", ")})`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`privacy check failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}
if (process.argv.includes("--history")) {
  try {
    inspectHistory();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
process.stdout.write(`privacy check passed: ${inspectedFiles} repository files inspected\n`);

function inspectHistory() {
  // Only commits reachable from HEAD are part of the branch being published.
  // Local backup branches may intentionally retain private development history
  // and must not make a clean public orphan branch fail this release gate.
  const revisions = execFileSync("git", ["rev-list", "HEAD"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const historyPatterns = [...new Set([account, home, "/Users/"])];
  for (const revision of revisions) {
    for (const pattern of historyPatterns) {
      try {
        const output = execFileSync("git", [
          "grep", "-I", "-n", "-F", "-e", pattern, revision,
          "--", ".", ":(exclude)scripts/privacy-check.mjs",
        ], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (output) throw new Error(`privacy history check failed:\n${output.split("\n").slice(0, 20).join("\n")}\nPublish from a clean orphan branch or rewrite private history before pushing.`);
      } catch (error) {
        if (error instanceof Error && "status" in error && error.status === 1) continue;
        throw error;
      }
    }
  }
  const authors = execFileSync("git", ["log", "HEAD", "--format=%an <%ae>"], { cwd: root, encoding: "utf8" });
  const configuredEmail = execFileSync("git", ["config", "--local", "user.email"], { cwd: root, encoding: "utf8" }).trim();
  const publicAuthors = new Set(authors.trim().split("\n").filter(Boolean));
  for (const author of publicAuthors) {
    if (!author.includes("users.noreply.github.com") && !author.endsWith(`<${configuredEmail}>`)) {
      throw new Error(`privacy history check failed: commit author may expose a personal email: ${author}`);
    }
  }
}
