import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexHookHandler } from "../../src/hook-runtime.js";

const directories: string[] = [];
let client: Client | undefined;
const extraClients: Client[] = [];

afterEach(async () => {
  if (client) await client.close();
  await Promise.all(extraClients.splice(0).map((value) => value.close()));
  client = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Codex MCP + Hook shared storage", () => {
  it("defaults MCP writes to the active cwd project and recalls them through UserPromptSubmit", async () => {
    const cwd = await temporaryDirectory("agentengram-codex-mcp-project-");
    const homeDir = await temporaryDirectory("agentengram-codex-mcp-home-");
    const cliPath = fileURLToPath(new URL("../../dist/mcp-cli.js", import.meta.url));
    expect(existsSync(cliPath), "build @agentengram/adapter-codex before the system test").toBe(true);
    client = new Client({ name: "agentengram-codex-mcp-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      cwd,
      env: mcpEnvironment(homeDir),
      stderr: "pipe",
    }));

    const remembered = parseJsonContent(await client.callTool({
      name: "memory.remember",
      arguments: {
        id: "codex-mcp-rule",
        name: "Codex MCP package rule",
        description: "A project-scoped package manager convention.",
        content: "Use pnpm for every AgentEngram workspace command.",
        type: "project",
        scope: "project",
        kind: "convention",
        sourceRefs: ["codex:mcp:test"],
      },
    })) as { projectId?: string };
    expect(remembered.projectId).toBeTruthy();

    const escaped = await client.callTool({
      name: "memory.remember",
      arguments: {
        id: "foreign-project",
        name: "Foreign project",
        description: "Must not cross the active host binding.",
        content: "This write must be rejected.",
        type: "project",
        scope: "project",
        projectId: "attacker-selected-project",
      },
    });
    expect(escaped.isError).toBe(true);

    const updated = parseJsonContent(await client.callTool({ name: "memory.update", arguments: {
      id: "codex-mcp-rule",
      targetMemoryId: "codex-mcp-rule",
      expectedRevision: 1,
      name: "Codex MCP package rule",
      description: "Updated project-scoped package manager convention.",
      content: "Use pnpm exclusively for every AgentEngram workspace command.",
      type: "project",
      scope: "project",
      kind: "convention",
      sourceRefs: ["codex:mcp:update"],
    } })) as { action: string; record: { revision: number } };
    expect(updated).toMatchObject({ action: "updated", record: { revision: 2 } });
    const corrected = parseJsonContent(await client.callTool({ name: "memory.correct", arguments: {
      targetMemoryId: "codex-mcp-rule",
      expectedRevision: 2,
      name: "Codex MCP package correction",
      description: "Final project package convention.",
      content: "Use pnpm for codex-final-package-token workspace commands.",
      scope: "project",
      sourceRefs: ["codex:mcp:correct"],
    } })) as { action: string };
    expect(corrected.action).toBe("superseded");

    const output = await createCodexHookHandler({ homeDir, formationEnabled: false, failOpen: false })({
      session_id: "session-mcp",
      turn_id: "turn-2",
      transcript_path: null,
      cwd,
      hook_event_name: "UserPromptSubmit",
      model: "gpt-test",
      permission_mode: "default",
      prompt: "Which package manager should codex-final-package-token workspace commands use?",
    });
    expect(output?.hookSpecificOutput?.additionalContext).toContain("Use pnpm for codex-final-package-token workspace commands");
    expect(output?.hookSpecificOutput?.additionalContext).not.toContain("Use pnpm exclusively for every AgentEngram workspace command");
  });

  it("rejects user, agent, and team operations until stable host identities are configured", async () => {
    const cwd = await temporaryDirectory("agentengram-codex-mcp-identity-project-");
    const homeDir = await temporaryDirectory("agentengram-codex-mcp-identity-home-");
    client = await connectMcp(cwd, homeDir);

    for (const scope of ["user", "agent", "team"] as const) {
      const remember = {
        id: `blocked-${scope}`,
        name: `Blocked ${scope}`,
        description: "Stable identity is intentionally absent.",
        content: "This record must not enter a legacy global lane.",
        type: "user",
        scope,
      };
      const calls = [
        { name: "memory.remember", arguments: remember },
        { name: "memory.upsert", arguments: remember },
        { name: "memory.update", arguments: { ...remember, targetMemoryId: remember.id } },
        { name: "memory.correct", arguments: {
          id: remember.id, targetMemoryId: remember.id, name: remember.name,
          description: remember.description, content: remember.content, scope,
        } },
        { name: "memory.search", arguments: { text: "legacy global lane", scope } },
        { name: "memory.read", arguments: { id: remember.id, scope } },
        { name: "memory.forget", arguments: { id: remember.id, scope } },
        { name: "memory.feedback", arguments: {
          id: remember.id, name: remember.name, description: remember.description,
          content: remember.content, scope,
        } },
      ] as const;
      for (const call of calls) {
        const result = await client.callTool(call);
        expect(result.isError, `${call.name} must reject unbound ${scope} scope`).toBe(true);
      }
    }
  });

  it("enables global scopes only for explicitly configured stable identities", async () => {
    const cwd = await temporaryDirectory("agentengram-codex-mcp-stable-project-");
    const homeDir = await temporaryDirectory("agentengram-codex-mcp-stable-home-");
    client = await connectMcp(cwd, homeDir, {
      AGENTENGRAM_USER_ID: "user-stable-1",
      AGENTENGRAM_AGENT_ID: "agent-stable-1",
      AGENTENGRAM_TEAM_ID: "team-stable-1",
    });

    for (const scope of ["user", "agent", "team"] as const) {
      const id = `configured-${scope}`;
      const remembered = await client.callTool({ name: "memory.remember", arguments: {
        id,
        name: `Configured ${scope}`,
        description: "Stable host identity is configured.",
        content: `configured-${scope}-token`,
        type: "user",
        scope,
      } });
      expect(remembered.isError).not.toBe(true);
      expect(parseJsonContent(await client.callTool({ name: "memory.read", arguments: { id, scope } })))
        .toMatchObject({ id, scope });
    }
  });

  it("shares project records and isolates local records across Codex worktrees", async () => {
    const { main, worktree } = await createWorktreePair();
    const homeDir = await temporaryDirectory("agentengram-codex-worktree-home-");
    client = await connectMcp(main, homeDir);
    const featureClient = await connectMcp(worktree, homeDir);
    extraClients.push(featureClient);

    await client.callTool({ name: "memory.remember", arguments: {
      id: "shared-project", name: "Shared project", description: "Shared rule",
      content: "Codex project uses shared-codex-token.", type: "project", scope: "project",
    } });
    await client.callTool({ name: "memory.remember", arguments: {
      id: "same-local", name: "Main local", description: "Main checkout",
      content: "Main checkout uses alpha-codex-token.", type: "project", scope: "local",
    } });
    await featureClient.callTool({ name: "memory.remember", arguments: {
      id: "same-local", name: "Feature local", description: "Feature checkout",
      content: "Feature checkout uses beta-codex-token.", type: "project", scope: "local",
    } });

    const handler = createCodexHookHandler({ homeDir, formationEnabled: false, failOpen: false });
    const mainRecall = await handler(codexPrompt(main, "main-session", "shared-codex-token alpha-codex-token beta-codex-token"));
    expect(mainRecall?.hookSpecificOutput?.additionalContext).toContain("shared-codex-token");
    expect(mainRecall?.hookSpecificOutput?.additionalContext).toContain("alpha-codex-token");
    expect(mainRecall?.hookSpecificOutput?.additionalContext).not.toContain("Feature checkout uses beta-codex-token");
    const featureRecall = await handler(codexPrompt(worktree, "feature-session", "shared-codex-token alpha-codex-token beta-codex-token"));
    expect(featureRecall?.hookSpecificOutput?.additionalContext).toContain("shared-codex-token");
    expect(featureRecall?.hookSpecificOutput?.additionalContext).toContain("beta-codex-token");
    expect(featureRecall?.hookSpecificOutput?.additionalContext).not.toContain("Main checkout uses alpha-codex-token");

    expect(parseJsonContent(await client.callTool({ name: "memory.read", arguments: { scope: "local", id: "same-local" } })))
      .toMatchObject({ content: "Main checkout uses alpha-codex-token." });
    expect(parseJsonContent(await featureClient.callTool({ name: "memory.read", arguments: { scope: "local", id: "same-local" } })))
      .toMatchObject({ content: "Feature checkout uses beta-codex-token." });
    await client.callTool({ name: "memory.forget", arguments: { scope: "local", id: "same-local" } });
    expect(parseJsonContent(await featureClient.callTool({ name: "memory.read", arguments: { scope: "local", id: "same-local" } })))
      .toMatchObject({ content: "Feature checkout uses beta-codex-token." });
  });
});

async function connectMcp(
  cwd: string,
  homeDir: string,
  identities: Readonly<Record<string, string>> = {},
): Promise<Client> {
  const cliPath = fileURLToPath(new URL("../../dist/mcp-cli.js", import.meta.url));
  const value = new Client({ name: "agentengram-codex-worktree-test", version: "0.0.0" });
  await value.connect(new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
    cwd,
    env: { ...mcpEnvironment(homeDir), ...identities },
    stderr: "pipe",
  }));
  return value;
}

function mcpEnvironment(homeDir: string): Record<string, string> {
  const environment = stringEnvironment({ ...process.env, AGENTENGRAM_HOME: homeDir });
  // Tests must not accidentally inherit developer-machine identities; absence
  // is the security condition exercised by the default Codex installation.
  delete environment.AGENTENGRAM_USER_ID;
  delete environment.AGENTENGRAM_AGENT_ID;
  delete environment.AGENTENGRAM_TEAM_ID;
  return environment;
}

function codexPrompt(cwd: string, sessionId: string, prompt: string) {
  return {
    session_id: sessionId, turn_id: "turn-1", transcript_path: null, cwd,
    hook_event_name: "UserPromptSubmit" as const, model: "gpt-test", permission_mode: "default", prompt,
  };
}

async function createWorktreePair(): Promise<{ readonly main: string; readonly worktree: string }> {
  const root = await temporaryDirectory("agentengram-codex-worktrees-");
  const main = join(root, "main");
  const worktree = join(root, "feature");
  const worktreeGitDir = join(main, ".git", "worktrees", "feature");
  await mkdir(worktreeGitDir, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");
  await writeFile(join(worktreeGitDir, "commondir"), "../..\n", "utf8");
  await writeFile(join(worktreeGitDir, "gitdir"), `${join(worktree, ".git")}\n`, "utf8");
  return { main, worktree };
}

function parseJsonContent(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const text = result.content.find((item): item is { type: "text"; text: string } => item.type === "text")?.text;
  if (!text) throw new Error("MCP result did not include text JSON content");
  return JSON.parse(text);
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
