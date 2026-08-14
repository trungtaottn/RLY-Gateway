# Agent Gateway Technology Stack

## Approved stack

| Concern | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript strict | Fast protocol iteration with explicit tagged unions |
| Runtime | Node.js active LTS | Stable cross-platform runtime and native fetch/streams |
| Package manager | pnpm | Deterministic lockfile and efficient local installs |
| HTTP server | Fastify | Streaming, hooks, lifecycle, and low framework overhead |
| HTTP client | Native fetch/Undici | Standards-based streaming and cancellation |
| Boundary validation | Zod | Validate config and external payload boundaries only |
| Tests | Vitest; Playwright Chromium for management UI AT-031 | Unit, contract, integration, lifecycle, E2E orchestration, and real-browser keyboard/viewport gates |
| Lint | ESLint flat config | TypeScript correctness and maintainability checks |
| Launch config | TOML, schema version 1 | Human-editable bootstrap and launch settings without raw secrets |
| Control-plane data | SQLite with explicit migrations | Provider/account/profile/pool/health/policy/audit metadata only |
| OAuth secrets | Project-owned restrictive files; optional OS backend later | Secret records never enter SQLite, Git, logs, or management DTOs |
| Logs | Structured JSON with deny-by-default redaction | Machine-readable diagnostics with privacy gates |

## Version policy

- Pin the pnpm version in `packageManager`.
- Declare a supported Node range and test it in CI.
- Commit the lockfile.
- Harness compatibility is evidence-based, not inferred from installed latest.
- Provider/model capability claims include a verification date and fixture revision.

## Repository shape

Use one modular TypeScript package. No monorepo, workspace orchestrator, generated SDK, or plugin SDK in V1. `pnpm-workspace.yaml` is settings-only (`allowBuilds` for esbuild); it does not add workspace packages. The local UI consumes the same versioned management contract and does not create a separate secret-owning backend.

Modules are created only when their phase owns real behavior:

- `src/core`
- `src/config`
- `src/credentials`
- `src/control-plane`
- `src/management`
- `src/profiles`
- `src/routing/pools`
- `src/runtime`
- `src/protocols`
- `src/providers`
- `src/registry`
- `src/observability`
- `src/cli`

## Quality commands

The foundation phase must provide equivalent scripts for:

```text
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:lifecycle
pnpm test:privacy
pnpm test:browser
pnpm lint
pnpm typecheck
pnpm build
```

Live provider smoke tests remain explicit and separate from default CI.

## Rejected alternatives

- Go: excellent lifecycle/single-binary properties, but slower for high-churn JSON/SSE protocol unions and fixtures.
- Rust: strongest low-level correctness, disproportionate development cost for a personal adapter-heavy gateway.
- Bun-only runtime: useful upstream reference, but Node LTS offers a more conservative compatibility boundary for the first release.
- Generic proxy frameworks: often flatten protocol semantics or add provider-marketplace scope.

## Security tooling requirements

- Secret/payload privacy scan.
- Dependency and license audit before release.
- Tests for redaction, loopback binding, transient auth, file permissions, and symlink resistance.
- No install/uninstall lifecycle scripts that mutate global client state.

## Unresolved questions

- Release support beyond the current Node 24 baseline will be selected after clean-install CI evidence exists.
