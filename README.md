# Agent Gateway

Personal, protocol-preserving gateway and local multi-provider control plane for coding-agent harnesses. Claude Code is the first-class client; Codex CLI follows through its own protocol boundary.

## Project status

The foundation, Anthropic Messages boundary, direct-provider Claude route,
authenticated control-plane/management contract, project-owned credential
broker with one Codex OAuth vertical slice, the deterministic account-pool
engine, and Claude Code profile/pool integration are implemented. The next integration target is Codex OAuth and ClinePass through Claude Code;
see [BACKLOG.md](./docs/BACKLOG.md) and [TASKLIST](./docs/TASKLIST.md).

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

Project-owned Gemini OAuth uses `AGENT_GATEWAY_GEMINI_OAUTH_CLIENT_ID`. There is no default client id and no Gemini CLI / Code Assist impersonation. Opt-in live smoke: `AGENT_GATEWAY_LIVE_GEMINI_OAUTH=1`. Cline create requires an explicit loopback or HTTPS `endpointPolicy` (never ports `10100`, `8317`, or `17870`). OpenCode Go and Alibaba have adapters but no reviewed TOML model routes yet; Alibaba stays terms-gated.

## Current CLI

```bash
pnpm dev doctor
pnpm dev status
pnpm dev quota
pnpm dev route-trace
pnpm dev admin providers list
pnpm dev admin credentials preview --source /path/to/auth.json
pnpm dev admin credentials import --source /path/to/auth.json --provider-id <id> --pseudonym acct-1 --source-fingerprint <sha256>
pnpm dev admin credentials login --provider-id <id> --pseudonym acct-1
pnpm dev admin accounts select --id <id> --version <n>
pnpm dev admin accounts revoke --id <id> --version <n>
pnpm dev admin ui
pnpm dev run claude --profile <name> -- --help
```

`run claude` starts or reuses only the deterministic, attested local gateway, then launches Claude with gateway settings scoped to that child process. `--profile <name>` activates a harness profile (pool and model roles) without preselecting an account; each launch gets a lease-scoped child token so concurrent profiles do not share request identity. `--profile` and `--route` cannot be combined. The same instance also binds the management listener on `127.0.0.1:17872`. `status` reports `not-running`, `attested-compatible`, `occupied-foreign`, or `stale-record`; only the compatible state is considered running. `doctor` validates configuration and profile/target readiness without exposing sensitive validation details. `quota` and `route-trace` print secret-free account quota classes and last-N in-memory route decisions from the running instance. `admin` talks to the running management listener with the separate per-instance bearer. Providers, accounts, pools, and profiles support create/list/update; pause/resume apply only to accounts. Credential import is explicit and read-only; login starts a PKCE loopback callback on `127.0.0.1:17873`. Select pins one ready account onto the Anthropic route when no profile is active; revoke removes usable project-owned credential files. `admin ui` issues a single-use fragment URL for a browser session on the management listener. There is no ownership-bypassing `serve` command.

With configured direct routes or a selected Codex OAuth account, the lifecycle
server also exposes authenticated Anthropic Messages and token-count endpoints.
Configured routes are explicit `primary`, `fast`, and `reasoning` mappings; the
gateway never auto-selects a model. Credential fields are `env:` or `handle:`
references, never raw secrets.

## Verification

```bash
pnpm exec playwright install chromium
pnpm test:unit
pnpm test:lifecycle
pnpm test:privacy
pnpm test:browser
pnpm lint
pnpm typecheck
pnpm build
```

`pnpm verify` includes `pnpm test:browser`. Install Chromium once with `pnpm exec playwright install chromium` before a clean-clone verify.

Contract and integration script names already exist and intentionally allow zero tests until their owning phases add real protocol/provider behavior.

## License

MIT. Adapted upstream code, when introduced, must be recorded in [`docs/provenance.md`](./docs/provenance.md) with its original notice, pinned artifact hash, and a row in the [adaptation matrix](./docs/source-adaptation-matrix.md).
