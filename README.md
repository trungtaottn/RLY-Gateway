# Agent Gateway

Personal, protocol-preserving gateway and local multi-provider control plane for coding-agent harnesses. Claude Code is the first-class client; Codex CLI follows through its own protocol boundary.

## Project status

The foundation, Anthropic Messages boundary, and direct-provider Claude route
are implemented. The active milestone freezes reusable MIT sources before
adding project-owned OAuth credentials, accounts, pools, profiles, management,
and UI; see [TASKLIST](./docs/TASKLIST.md).

## Start here

| Document | Authority |
| --- | --- |
| [SPEC.md](./docs/SPEC.md) | Product contract, scope, requirements, acceptance criteria |
| [Requirements pack](./docs/requirements/README.md) | Vision, BRD, SRS, FRS, use cases, stories, RTM, and Acceptance Test Cases |
| [TASKLIST.md](./docs/TASKLIST.md) | Current committed work and phase progress |
| [BACKLOG.md](./docs/BACKLOG.md) | Uncommitted future work |
| [ROADMAP.md](./docs/ROADMAP.md) | Milestones and release sequence |
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Durable system boundaries and contracts |
| [TECH-STACK.md](./docs/TECH-STACK.md) | Approved runtime, tooling, and quality gates |
| [Project decisions](./docs/project-decisions.md) | Accepted product and operational defaults |
| [Implementation plan](./plans/260813-1239-claude-first-personal-gateway/plan.md) | Detailed execution state and phase gates |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Daily development workflow |
| [AGENTS.md](./AGENTS.md) | Required reading/update contract for coding agents |

## Product shape

```text
Claude Code / Codex CLI
        ↓
client protocol adapter + required capabilities
        ↓
versioned control-plane policy
        ↓
request-time account eligibility and selection
        ↓
immutable EffectiveRoute + credential generation
        ↓
direct / OAuth / interoperability / bridge adapter
```

## Safety invariants

- No persistent mutation of global Claude or Codex configuration by default.
- No credential scraping from another client.
- Credential import is explicit and read-only by default; project-owned records become canonical.
- No account rotation after the first response byte or tool event.
- No blind process termination or automatic port increment.
- No prompt, response, token, email, or account identity in default logs.
- Existing gateway boundaries on ports `10100`, `8317`, and `17870` are never managed by this project.

## Local setup

Requirements: Node.js 24 and pnpm 11.16.

```bash
pnpm install --frozen-lockfile
cp gateway.config.example.toml gateway.config.toml
pnpm dev doctor
pnpm dev status
pnpm verify
```

The example route contains placeholder model IDs and requires no credential for `doctor`. Do not commit the local configuration or place a raw secret in it; credential fields contain references such as `env:OPENROUTER_API_KEY`.

## Current CLI

```bash
pnpm dev doctor
pnpm dev status
pnpm dev run claude -- --help
```

`run claude` starts or reuses only the deterministic, attested local gateway, then launches Claude with gateway settings scoped to that child process. `status` reports `not-running`, `attested-compatible`, `occupied-foreign`, or `stale-record`; only the compatible state is considered running. `doctor` validates configuration without exposing sensitive validation details. There is no ownership-bypassing `serve` command. Control-plane commands and UI described in the roadmap are not implemented yet.

With configured direct routes, the lifecycle server also exposes authenticated
Anthropic Messages and token-count endpoints. Routes are explicit `primary`,
`fast`, and `reasoning` mappings; the gateway never auto-selects a model.

## Verification

```bash
pnpm test:unit
pnpm test:lifecycle
pnpm test:privacy
pnpm lint
pnpm typecheck
pnpm build
```

Contract and integration script names already exist and intentionally allow zero tests until their owning phases add real protocol/provider behavior.

## License

MIT. Adapted upstream code, when introduced, must be recorded in [`docs/provenance.md`](./docs/provenance.md) with its original notice, pinned artifact hash, and a row in the [adaptation matrix](./docs/source-adaptation-matrix.md).
