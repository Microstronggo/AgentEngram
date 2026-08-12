# AgentEngram

[中文文档](README.zh-CN.md)

AgentEngram is a framework-neutral **Context & Memory Runtime** for AI agents. It can enhance an existing agent through Hooks or MCP, or manage the model-facing context when a host explicitly transfers context ownership.

An *engram* is a durable trace left by experience. AgentEngram preserves those traces as portable transcripts and turns them into usable short-term context and long-term memory.

AgentEngram keeps a portable, append-only transcript and provides:

- Short-term memory: tool-result budgeting, history snipping, micro-compaction, staged collapse, compaction, session memory, checkpoint/resume/fork.
- Long-term memory: typed factual, episodic, procedural, and semantic memories; Markdown truth; FTS5 recall; formation, correction, aging, and consolidation.
- Integrations: Pi native extension, Codex Hooks plus MCP, and a generic MCP stdio server.
- Reliability: checksummed export/import, durable background jobs, repairable projections, project/worktree isolation, and fail-open adapter behavior.

## Requirements

- Node.js 22.19 or later for the Pi adapter; Engine, Codex, and MCP require Node.js 22.5 or later.
- pnpm 10 for repository development.
- `better-sqlite3` install scripts must be allowed so FTS5 and durable jobs are available.

## Install

Engine API:

```bash
pnpm add @agentengram/engine
```

Pi:

```bash
pi install npm:@agentengram/adapter-pi
pnpm dlx @agentengram/engine setup pi
pnpm dlx @agentengram/engine doctor --adapter pi --json
```

Codex:

```bash
pnpm add @agentengram/adapter-codex
pnpm dlx @agentengram/engine setup codex
pnpm dlx @agentengram/engine doctor --adapter codex --json
```

Generic MCP server:

```bash
pnpm add -g @agentengram/mcp
agentengram-mcp
```

Context ownership and Provider behavior are configured explicitly; use the development commands below to verify a local checkout.

## Context ownership

| Integration | Default | Managed context |
| --- | --- | --- |
| Pi | `enhance` | Supported only by explicit opt-in after capability checks |
| Codex | `enhance` | Not supported by current Hooks |
| MCP-only host | explicit memory tools | Not supported without a native context Hook |

The host keeps its canonical operational transcript. AgentEngram stores a portable transcript and never deletes the host transcript when projecting or compacting context.

## Provider policy

AgentEngram does not configure a paid model by default.

- Pi uses the host's current model for Compact and Cell Formation by default.
- Codex automatic Formation remains disabled until an OpenAI-compatible Provider is explicitly configured.
- Provider configuration stores only an environment-variable name, never a token.

```json
{
  "schemaVersion": 1,
  "provider": {
    "type": "openai-compatible",
    "baseUrl": "https://provider.example/v1",
    "model": "model-name",
    "apiKeyEnv": "MY_LLM_API_KEY"
  },
  "adapters": {
    "codex": {
      "mode": "enhance",
      "models": {
        "formation": { "strategy": "configured-provider", "fallback": "disabled" }
      }
    }
  }
}
```

## Operations

```bash
agentengram --version
agentengram config print --effective --redacted
agentengram inspect
agentengram transcript verify
agentengram data export --output ./agentengram-bundle
agentengram data purge --dry-run
```

AgentEngram stores raw conversations and derived memories locally. Portable bundles are integrity-checked but not encrypted; protect the data directory and explicitly review configured model access before production use. Remote telemetry is disabled by default.

## Development

```bash
corepack enable
pnpm install
pnpm check
pnpm check:release
```

`pnpm check:release` runs the test suite, package and privacy gates, history-author checks, and a clean package installation.

## Packages

| Package | Purpose |
| --- | --- |
| `@agentengram/engine` | Context, transcript, short-term memory, long-term memory, storage, and Runtime |
| `@agentengram/adapter-pi` | Pi Hooks and optional managed-context integration |
| `@agentengram/adapter-codex` | Codex Hooks, portable transcript, recall, Formation worker, and MCP |
| `@agentengram/mcp` | Generic MCP stdio memory server |

## Status

AgentEngram is an experimental `0.1.x` preview. Durable schemas are versioned, but APIs and adapter compatibility may still change before `1.0`.

Licensed under the [Apache License 2.0](LICENSE).
