#!/usr/bin/env node
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureDataLayout, loadAgentEngramConfig, MarkdownMemoryStore, MemoryApplicationService, SqliteFtsMemoryIndex } from "@agentengram/engine";
import { createMemoryMcpServer } from "./server.js";

const installed = await loadAgentEngramConfig();
const root = installed.config.dataDir!;
await ensureDataLayout(root);
await mkdir(join(root, "indexes"), { recursive: true });
const index = new SqliteFtsMemoryIndex(join(root, "indexes", "memory.db"));
const service = new MemoryApplicationService(new MarkdownMemoryStore(root), index);
const server = createMemoryMcpServer(service);
const shutdown = () => {
  index.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
await server.connect(new StdioServerTransport());
