# RLY Gateway

Personal, protocol-preserving gateway and local multi-provider control plane. Claude Code is the coding harness; RLY profiles are the aliases (`rly <profile>`); Codex CLI is an explicit `rly run codex` escape hatch.

## Project status

The foundation, Anthropic Messages boundary, direct-provider Claude route,
authenticated control-plane/management contract, project-owned credential
broker, deterministic account pools, Claude Code profile integration, the
Codex CLI Responses harness, the resident runtime service/bootstrap, the
standalone runtime artifact pipeline, and the signed release supply chain
(canonical release manifest, SBOM/provenance, Ed25519 signing, signed channel
metadata, exact-byte qualification) are implemented. Remaining next-focus
work is Codex OAuth and ClinePass through Claude Code and the verified
installer/updater UX (#129); see
[BACKLOG.md](./docs/BACKLOG.md) and [TASKLIST](./docs/TASKLIST.md).

## Distribution

Standalone RLY-owned runtime artifacts are the **primary production
distribution** (#35): self-contained packages that bundle the exact pinned
Node runtime and install/run without a user-provisioned Node/npm/pnpm
toolchain or a source checkout. GitHub Releases is the artifact origin
(`rly-<version>-<target>.tar.gz` + sha256 + `artifacts.json`); npm/Homebrew,
if introduced, are secondary convenience channels pointing at the same
canonical artifact lineage. External Node is a development concern only. See
`scripts/standalone/`, `docs/ARCHITECTURE.md`, and `docs/release-governance.md`.

## Release supply chain

The artifact lineage is published through a signed release supply chain
(#128): a canonical release manifest (`rly-release.json`), per-artifact SBOMs
and provenance referencing the exact artifact digest, Ed25519 signatures, and
signed channel metadata (`rly-channel-<channel>.json`) mapping beta/stable to
exact digests — **exact-byte qualification is the publication authority** (a
release is promoted only on evidence produced by installing and exercising
the exact artifact digest later published). The signing private key lives only
in the repository secret `RLY_RELEASE_SIGNING_KEY`; the public key is
committed at `scripts/release/signing-public-key.pem`. See
`scripts/release/` and `docs/release-governance.md`.

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
Claude Code (`rly <profile>`)
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
- RLY-launched Claude sessions use durable RLY-owned, profile-scoped Claude configuration views under `~/.rly/claude/views/<view-id>` (native `~/.claude` stays read/compose-only input; RLY session/model state persists per profile; a plain `claude` launch is never affected).
- No credential scraping from another client.
- Credential import is explicit and read-only by default; project-owned records become canonical.
- No account rotation after the first response byte or tool event.
- No blind process termination or automatic port increment.
- No prompt, response, token, email, or account identity in default logs.
- Existing gateway boundaries on ports `10100`, `8317`, and `17870` are never managed by this project.

## Local setup

Requirements: Node.js 24 and pnpm 11.16. **These are development requirements
only** — released standalone artifacts bundle their own pinned Node runtime and
need neither.

```bash
pnpm install --frozen-lockfile
cp gateway.config.example.toml gateway.config.toml
pnpm dev doctor
pnpm dev status
pnpm verify
```

The example route contains placeholder model IDs and requires no credential for `doctor`. `pnpm dev` runs the source checkout; an installed package exposes the `rly` executable shown below. Do not commit the local configuration or place a raw secret in it; credential fields contain references such as `env:OPENROUTER_API_KEY`.

RLY stores its durable local control-plane state in `~/.rly`. On its first start after this rename, RLY atomically migrates a complete legacy `~/.agent-gateway` tree only when `~/.rly` is absent. If both roots exist, RLY stops without modifying either directory; back up or move one root before retrying.

Project-owned Gemini OAuth uses `RLY_GEMINI_OAUTH_CLIENT_ID`. There is no default client id and no Gemini CLI / Code Assist impersonation. Opt-in live smoke: `RLY_LIVE_GEMINI_OAUTH=1`. Cline create requires an explicit loopback or HTTPS `endpointPolicy` (never ports `10100`, `8317`, or `17870`). OpenCode Go and Alibaba have adapters but no reviewed TOML model routes yet; Alibaba stays terms-gated.

## Current CLI

```bash
rly init
rly config
rly config status
rly config providers list
rly config providers create --name codex --mode oauth
rly config accounts list
rly config accounts login --provider-id <id> --pseudonym acct-1
rly config accounts import --provider-id <id> --pseudonym acct-1 --source /path/to/auth.json --source-fingerprint <sha256>
rly config accounts revoke --id <id> --version <n>
rly config accounts refresh --id <id> --version <n>
rly config pools create --name codex-pool --provider-id <id> --strategy fill-first --accounts <a>,<b>
rly config profiles create --name codex --harness claude --provider-id <id> --pool-id <pool> --roles '{"primary":"gpt-5.4"}'
rly gateway status
rly gateway stop
rly gateway start
rly update [--candidate <dir>] [--version <v>] [--force] [--wait-timeout <ms>]
rly doctor
rly status
rly quota
rly route-trace
rly admin providers list
rly admin credentials preview --source /path/to/auth.json --provider-id <id>
rly admin credentials import --source /path/to/auth.json --provider-id <id> --pseudonym acct-1 --source-fingerprint <sha256>
rly admin credentials login --provider-id <id> --pseudonym acct-1
rly admin accounts select --id <id> --version <n>
rly admin accounts revoke --id <id> --version <n>
rly admin ui
rly <profile>
rly <profile> -- -p fixture
rly run claude --profile <name> -- --help
rly run codex -- --help
```

`rly init` bootstraps the per-user installation: it settles the durable `~/.rly` home, validates the control-plane store, registers the per-user service idempotently (macOS LaunchAgent `com.rly.gateway` or Linux `systemd --user`, never root), starts the resident runtime, and waits for an attested compatible instance. The resident runtime stays alive after Claude/Codex sessions close and is reused by `rly <profile>`, config, and diagnostics; the foreground launcher remains the fallback when no service is initialized. On macOS the LaunchAgent starts again at login/reboot, restarts crashes within launchd's bounded throttle policy, and writes its stdout/stderr into `~/.rly/logs/service.log`; on Linux the `systemd --user` unit (`~/.config/systemd/user/rly-gateway.service`) starts again whenever the user's systemd manager starts, restarts crashes under a bounded `StartLimit`/`Restart` policy, and appends its stdout/stderr to `~/.rly/logs/service.log`. A session without a reachable user systemd manager (containers, minimal distros, WSL without systemd) fails actionably and RLY never auto-enables `loginctl enable-linger`. Re-running `rly init` repairs a changed/stale definition without duplicating the service. `rly gateway status` reports runtime readiness plus service label/load state/pid (and enabled state on Linux); `rly gateway stop` shuts the resident runtime down through the attested in-process shutdown. No credential, token, or account identity is ever written into the service definition, logs, or diagnostics.

`rly update` runs the safe zero-downtime update lifecycle: candidate installation and activation are separate durable states. With `--candidate <dir> [--version <v>]` a verified candidate is installed while the current resident runtime keeps serving; existing Claude sessions keep running on the old process until they drain (launch-session count, not TCP), `--force` is the explicit destructive path, and activation restarts only the attested resident runtime through the per-user service manager, verifies the new runtime identity/readiness, and rolls back to the previous known-good version on failure. `rly status`/`rly doctor` expose allowlisted update metadata (state, current/pending/previous version, active sessions, CLI↔runtime compatibility). The signed/verified artifact distribution channel remains a separate backlog item (#35); this command owns the lifecycle once a candidate is obtained.

`rly config` is the primary user-facing control plane after `rly init`: it resolves the durable configuration from the `~/.rly` installation record (no `gateway.config.toml` in the current directory is required), ensures or recovers the resident runtime, and productizes the existing management surface. Bare `rly config` (or `rly config ui`) opens the local loopback config UI — providers, accounts, pools, profiles, health/quota, audit, and route traces — and prints the URL; `--headless` prints the bootstrap URL without opening a browser. `rly config status` prints a secret-free summary (runtime state, policy revision, resource counts, health). Focused shortcuts `rly config providers|accounts|pools|profiles` create/list through the same management API that `rly admin` uses, so both surfaces observe exactly one policy revision. Credential login/import/refresh/revoke reuse the credential broker and persist only handle/generation metadata. Closing the config UI never stops the resident runtime. `rly admin` remains the advanced/operator surface over the same endpoints.

`rly <profile>` is the canonical launch: it starts or reuses the attested local gateway and launches Claude Code with that profile (for example `rly codex`, `rly clinepass`, `rly deepseek`). Provider names are not harnesses. `rly run claude --profile <name>` remains compatibility. `rly run codex` launches Codex CLI and is not a profile alias. `--profile` cannot be combined with a bare profile token or with `--route`. Each profile launch gets a lease-scoped child token so concurrent profiles do not share request identity. The same instance also binds the management listener on `127.0.0.1:17872`. `status` reports `not-running`, `attested-compatible`, `occupied-foreign`, or `stale-record`; only the compatible state is considered running. `doctor` validates configuration and profile/target readiness without exposing sensitive validation details. `quota` prints pseudonym and quota class only. `route-trace` prints profile name, decision reason, and selected pseudonym only. `admin` talks to the running management listener with the separate per-instance bearer. Providers, accounts, pools, and profiles support create/list/update; pause/resume apply only to accounts. Credential import is explicit and read-only; login starts a PKCE loopback callback on `127.0.0.1:17873`. Select pins one ready account onto the Anthropic route when no profile is active; revoke removes usable project-owned credential files. `admin ui` issues a single-use fragment URL for a browser session on the management listener. There is no ownership-bypassing `serve` command. Reserved commands are `status`, `doctor`, `quota`, `route-trace`, `admin`, `run`, `init`, `gateway`, and `config`; a colliding profile name must use `rly run claude --profile`. Unknown profiles fail closed.

With configured direct routes or a selected Codex OAuth account, the lifecycle
server also exposes authenticated Anthropic Messages and token-count endpoints.
Configured routes are explicit `primary`, `fast`, and `reasoning` mappings; the
gateway never auto-selects a model. Credential fields are `env:` or `handle:`
references, never raw secrets.

## Codex subscription through Claude Code

Canonical launch is `rly codex`: Claude Code using a RLY Claude profile named `codex` against a Codex OAuth pool. `rly run codex` is Codex CLI and is not this path. `--profile` and `--route` stay exclusive.

1. Bootstrap once, then open the config control plane:

```bash
rly init
rly config
```

`rly config` opens the local config UI (add providers/accounts/pools/profiles there), or use the focused shortcuts below. `rly config` resolves the durable configuration from `~/.rly` and recovers the resident runtime when it is not already running.

2. Create the Codex OAuth provider:

```bash
rly config providers create --name codex --mode oauth
```

3. Add accounts by PKCE login or explicit import. Do not paste access tokens, refresh tokens, emails, or account ids into the shell, docs, or tickets.

```bash
rly config accounts login --provider-id <provider-id> --pseudonym acct-1
```

Or import a local Codex `auth.json` after previewing the fingerprint:

```bash
rly admin credentials preview --source /path/to/auth.json --provider-id <provider-id>
rly config accounts import --source /path/to/auth.json --provider-id <provider-id> --pseudonym acct-1 --source-fingerprint <sha256>
```

Repeat login or import for each additional OAuth account you want in the pool.

4. Create a pool that contains those account ids, then a Claude harness profile named `codex` whose model roles are reviewed Codex ids (today `gpt-5.4`):

```bash
rly config pools create --name codex-pool --provider-id <provider-id> --strategy fill-first --accounts <account-id>,<account-id>
rly config profiles create --name codex --harness claude --provider-id <provider-id> --pool-id <pool-id> --roles '{"primary":"gpt-5.4","fast":"gpt-5.4","reasoning":"gpt-5.4"}'
```

5. Launch Claude Code through that profile:

```bash
rly codex
rly run claude --profile codex --
```

The second form is compatibility only. Unknown required capabilities fail closed. Codex models are not remapped onto OpenRouter or other provider evidence.

## ClinePass through Claude Code

Canonical launch is `rly clinepass`: Claude Code using a RLY Claude profile named `clinepass` against a ClinePass credential pool. Catalog/provider id stays `cline`. RLY owns imported credentials; import is one-time and read-only. Continuous Cline store lock/writeback/restore is not default. `--profile` and `--route` stay exclusive.

1. Bootstrap once, then open the config control plane (`rly config` opens the local UI; the focused shortcuts below work headless):

```bash
rly init
rly config
```

2. Create the Cline provider with an explicit loopback or HTTPS endpoint (never ports `10100`, `8317`, or `17870`):

```bash
rly config providers create --name cline --mode oauth --endpoint https://api.example.invalid/v1
```

3. Preview then import a local Cline `auth.json`. Preview without `--provider-id` is rejected. Do not paste access tokens, refresh tokens, emails, or account ids into the shell, docs, or tickets. Import does not write the Cline store.

```bash
rly admin credentials preview --source /path/to/auth.json --provider-id <provider-id>
rly config accounts import --source /path/to/auth.json --provider-id <provider-id> --pseudonym acct-1 --source-fingerprint <sha256>
```

Repeat preview+import for each additional Cline account you want in the pool.

4. Create a pool that contains those account ids, then a Claude harness profile named `clinepass` whose model roles are reviewed Cline ids (today `claude-sonnet-4-5`):

```bash
rly config pools create --name clinepass-pool --provider-id <provider-id> --strategy fill-first --accounts <account-id>,<account-id>
rly config profiles create --name clinepass --harness claude --provider-id <provider-id> --pool-id <pool-id> --roles '{"primary":"claude-sonnet-4-5","fast":"claude-sonnet-4-5","reasoning":"claude-sonnet-4-5"}'
```

5. Launch Claude Code through that profile:

```bash
rly clinepass
rly run claude --profile clinepass --
```

The second form is compatibility only. Unknown required capabilities fail closed. Cline models are not remapped onto Codex, OpenRouter, or other provider evidence. Opt-in live smoke: `RLY_LIVE_CLINEPASS=1` (plus `RLY_LIVE_CLINE_HANDLE` and `RLY_LIVE_CLINE_ENDPOINT`); skipped ≠ pass.

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

## Release lanes

`dev` is the Beta lane and `main` is the Stable lane. Full verification runs once on PRs targeting either lane; trusted post-merge updates release without repeating the suite. The first future public Stable baseline is a separate clean-snapshot operation that keeps historical private development commits private. After that bootstrap, normal promotion preserves branch ancestry.

Git tags and GitHub Releases are the release record. `dev` creates `-beta.N` prereleases and `main` creates stable releases through semantic-release; the package stays private and is never published to npm.

After a Stable release, `release-stable.yml` may move `dev` to the released
`main` SHA only after it proves that `dev` is an ancestor and both trees are
identical. The update is an API fast-forward (`force: false`), creates no
commit or PR. GitHub does not allow the built-in Actions integration to bypass
a personal repository ruleset, so the owner must install a dedicated GitHub App
on this repository only, grant it only Contents read/write, and configure:

- Repository variable `RLY_RELEASE_ALIGNMENT_APP_CLIENT_ID` and secret
  `RLY_RELEASE_ALIGNMENT_APP_PRIVATE_KEY` for the installation token.
- Repository variable `RLY_RELEASE_ALIGNMENT_APP_SLUG` containing the app slug
  without `[bot]`; Beta skips its release job when this app performs the
  alignment, so no second Beta release or Slack message is created. Full CI
  stays PR-only.
- A replacement `dev` branch ruleset that preserves PR-only, strict
  `required-ci`, deletion prevention, and non-fast-forward prevention for all
  actors, with an `always` bypass only for that installed app. Do not use a PAT
  or a broad workflow bypass.

Set the repository Actions secret `SLACK_WEBHOOK_URL` to enable release
messages. Missing Slack configuration is reported by the workflow and never
rolls back a GitHub Release, tag, or ref.

## License

MIT. Adapted upstream code, when introduced, must be recorded in [`docs/provenance.md`](./docs/provenance.md) with its original notice, pinned artifact hash, and a row in the [adaptation matrix](./docs/source-adaptation-matrix.md).
