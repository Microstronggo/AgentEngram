import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("MCP stdio system client", () => {
  let agentEngramHome: string;
  let client: Client | undefined;

  beforeEach(async () => {
    agentEngramHome = await mkdtemp(join(tmpdir(), "agentengram-mcp-"));
  });

  afterEach(async () => {
    if (client) {
      await client.close();
      client = undefined;
    }
    await rm(agentEngramHome, { recursive: true, force: true });
  });

  it("writes, searches, and reads long-term memory through a real stdio server", async () => {
    const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
    expect(existsSync(cliPath), "run pnpm --filter @agentengram/mcp build before this system test").toBe(true);

    client = new Client({ name: "agentengram-mcp-system-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: stringEnvironment({ ...process.env, AGENTENGRAM_HOME: agentEngramHome }),
      stderr: "pipe",
    }));

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "memory.remember",
      "memory.upsert",
      "memory.update",
      "memory.correct",
      "memory.search",
      "memory.read",
      "context.inspect",
    ]));

    const remembered = parseJsonContent(await client.callTool({
      name: "memory.remember",
      arguments: {
        id: "stdio-decision",
        name: "Stdio Decision",
        description: "MCP stdio writes durable AgentEngram records",
        content: "Project stdio-green-field decisions must be discoverable by MCP search.",
        type: "project",
        scope: "project",
        kind: "decision",
        projectId: "stdio-project",
        sourceRefs: ["system-test:mcp-stdio"],
        confidence: 0.93,
        importance: 0.91,
      },
    })) as { id: string; projectId: string; scope: string };
    expect(remembered).toMatchObject({ id: "stdio-decision", projectId: "stdio-project", scope: "project" });

    const storedMarkdown = await readFile(
      join(agentEngramHome, "projects", "stdio-project", "project", "stdio-decision.md"),
      "utf8",
    );
    expect(storedMarkdown).toContain("stdio-green-field");

    const searchResults = parseJsonContent(await client.callTool({
      name: "memory.search",
      arguments: {
        text: "stdio-green-field",
        projectId: "stdio-project",
        scope: "project",
        limit: 3,
      },
    })) as Array<{ record: { id: string; content: string } }>;
    expect(searchResults[0]?.record).toMatchObject({
      id: "stdio-decision",
      content: expect.stringContaining("stdio-green-field"),
    });

    const readResult = parseJsonContent(await client.callTool({
      name: "memory.read",
      arguments: {
        scope: "project",
        id: "stdio-decision",
        projectId: "stdio-project",
      },
    })) as { id: string; sourceRefs: string[] };
    expect(readResult).toMatchObject({ id: "stdio-decision", sourceRefs: ["system-test:mcp-stdio"] });

    const upsertArguments = {
      name: "Idempotent preference",
      description: "Transport retries are safe",
      content: "MCP retries must create one durable memory.",
      type: "user",
      scope: "user",
      idempotencyKey: "stdio-tool-call-1",
      sourceRefs: ["system-test:mcp-upsert"],
    };
    const firstUpsert = parseJsonContent(await client.callTool({ name: "memory.upsert", arguments: upsertArguments })) as {
      action: string; record: { id: string };
    };
    const retriedUpsert = parseJsonContent(await client.callTool({ name: "memory.upsert", arguments: upsertArguments })) as {
      action: string; record: { id: string };
    };
    expect(firstUpsert.action).toBe("created");
    expect(retriedUpsert).toMatchObject({ action: "duplicate", record: { id: firstUpsert.record.id } });
    const updated = parseJsonContent(await client.callTool({ name: "memory.update", arguments: {
      ...upsertArguments,
      content: "MCP retries and updates must preserve one durable memory.",
      targetMemoryId: firstUpsert.record.id,
      expectedRevision: 1,
    } })) as { action: string; record: { revision: number } };
    expect(updated).toMatchObject({ action: "updated", record: { revision: 2 } });
    const stale = parseJsonContent(await client.callTool({ name: "memory.update", arguments: {
      ...upsertArguments,
      content: "A stale writer must not win.",
      targetMemoryId: firstUpsert.record.id,
      expectedRevision: 1,
    } })) as { action: string; record: { revision: number } };
    expect(stale).toMatchObject({ action: "conflict", record: { revision: 2 } });
    const corrected = parseJsonContent(await client.callTool({ name: "memory.correct", arguments: {
      name: "Idempotent preference correction",
      description: "Final transport rule",
      content: "MCP retry behavior is correction-final-token.",
      scope: "user",
      targetMemoryId: firstUpsert.record.id,
      expectedRevision: 2,
      sourceRefs: ["system-test:mcp-correct"],
    } })) as { action: string; record: { supersedes: string } };
    expect(corrected).toMatchObject({ action: "superseded", record: { supersedes: firstUpsert.record.id } });
    const correctedSearch = parseJsonContent(await client.callTool({ name: "memory.search", arguments: {
      text: "correction-final-token", scope: "user", limit: 3,
    } })) as Array<{ record: { content: string } }>;
    expect(correctedSearch[0]?.record.content).toContain("correction-final-token");
  });
});

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
