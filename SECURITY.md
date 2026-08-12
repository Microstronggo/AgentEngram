# Security Policy

AgentEngram stores raw conversation transcripts and durable memories locally. Treat `AGENTENGRAM_HOME` as sensitive application data and do not publish it in issue reports.

## Reporting

Use GitHub private vulnerability reporting for the repository when available. If that channel is unavailable, open a content-free issue asking the maintainers for a private contact method. Never place credentials, transcripts, memory files, portable bundles, or exploit details in a public issue.

## Supported versions

The project is currently an experimental `0.1.x` preview. Security fixes apply to the latest revision only. A formal supported-version table will be published before a stable release.

## Secrets

- Provider keys must be passed through environment variables.
- Configuration stores only the environment variable name, never the secret value.
- `agentengram doctor` and `inspect` must not print transcript or memory content.
- Portable bundles contain user data and must be protected like the original data directory.
