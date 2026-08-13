# Security Policy

No public release exists yet. Security fixes apply to the current `main` branch during bootstrap.

## Reporting

Report suspected vulnerabilities privately to the repository owner. Do not include live credentials, real prompts, responses, or account identity in an issue or diagnostic artifact.

## Security model

- Gateway binds to loopback and requires a transient launcher-provided token.
- Direct credentials are resolved from approved references and never committed.
- Managed bridges retain OAuth and lifecycle ownership.
- Global Claude/Codex configuration is not persisted by normal launch flows.
- Foreign port owners are never signaled.
- Prompt and response bodies are not logged by default.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) and the accepted ADRs for trust boundaries.

## Secret exposure response

1. Stop the affected release or test.
2. Rotate the exposed credential through its owner/provider.
3. Remove the capture path and extend privacy tests.
4. Review repository history and generated artifacts before resuming.

