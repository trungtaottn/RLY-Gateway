# Security Policy

No public release exists yet. Security fixes apply to the current `main` branch during bootstrap.

## Reporting

Report suspected vulnerabilities privately to the repository owner. Do not include live credentials, real prompts, responses, or account identity in an issue or diagnostic artifact.

## Security model

- Gateway binds to loopback and requires a transient launcher-provided token.
- Direct credentials are resolved from approved references and never committed.
- Project-owned OAuth credentials live outside Git in a `0700` directory with `0600` files, atomic replacement, generation CAS, backup, and recovery. SQLite stores handles and metadata only.
- Import from another client store is explicit and read-only by default. Shared-store interoperability requires provider-specific locking and recovery tests.
- Managed bridges may retain OAuth and lifecycle ownership when selected for a provider.
- Management and data boundaries bind loopback only. Management requires authentication, Origin/CSRF checks, and versioned mutations.
- Global Claude/Codex configuration is not persisted by normal launch flows.
- Foreign port owners are never signaled.
- Prompt and response bodies are not logged by default.
- Account pools filter eligibility before selection and cannot rotate after the first response byte or tool event.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) and the accepted ADRs for trust boundaries.

## Secret exposure response

1. Stop the affected release or test.
2. Rotate the exposed credential through its owner/provider.
3. Remove the capture path and extend privacy tests.
4. Review repository history and generated artifacts before resuming.
