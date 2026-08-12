# Contributing

AgentEngram V1 focuses on framework-neutral context/memory contracts and the Pi/Codex adapters. New framework adapters should wait until the existing contract is insufficient and must include conformance and real-host fixtures.

## Development

```bash
corepack enable
pnpm install
pnpm check
```

The release gate additionally performs a network-backed clean installation:

```bash
pnpm check:release
```

Tests must not use a real model unless `AGENTENGRAM_ONLINE_TESTS=1` is explicitly set. New memory and context logic requires deterministic unit tests; adapter changes require system or conformance coverage.

## Code conventions

- Use English comments for public types and non-obvious state transitions.
- Keep raw transcript facts immutable and derived indexes rebuildable.
- Do not accept user, project, team, or agent identity from model-generated tool input.
- Do not silently downgrade an explicit managed-context request.

## Release metadata

Public packages use Apache-2.0 and repository metadata points to `Microstronggo/AgentEngram`. Run `pnpm check:release` before proposing a release.
