# Project Decisions

## Product identity

- Brand/product: `RLY` / `RLY Gateway`.
- Repository/package/CLI: `RLY-Gateway` / `rly-gateway` / `rly`.
- Local checkout and durable state root: `rly-gateway` / `~/.rly`.
- The first RLY start migrates a legacy `~/.agent-gateway` tree only when `~/.rly` is absent; two roots are an operator-resolved conflict.
- Development posture: private-first and public-ready.
- License: MIT, with per-module upstream provenance for copied or substantially adapted code.

## Runtime defaults

- TypeScript strict on Node.js active LTS.
- pnpm, Fastify, native fetch/Undici, Zod at external/config boundaries, Vitest.
- TOML launch configuration plus versioned SQLite control-plane metadata.
- Deterministic default loopback port `17871`.
- Persistent per-user resident runtime service first: `rly init` installs a user LaunchAgent (macOS) or `systemd --user` unit (Linux), starts the resident runtime, and `rly <profile>`/diagnostics reuse it. The foreground launcher lifecycle remains the fallback when no service is initialized. (Supersedes the earlier "foreground first, background service later" posture; see ADR 0006.)
- macOS LaunchAgent specifics (#33): one stable per-user label `com.rly.gateway` in the current user's `gui/<uid>` launchd domain; `~/Library/LaunchAgents` plist at mode `0600`; normal `rly init` never requires root and refuses to run as root; service stdout/stderr land in the durable RLY log directory (`~/.rly/logs/service.log`); the plist holds absolute executable/state paths only and contains no credentials, tokens, or account identity; crash restart is bounded by an explicit launchd `ThrottleInterval` so repeated broken startups are diagnosable rather than a tight loop; changed/stale definitions are unloaded before reload during init/update; launchctl v2 and legacy subcommands are both tolerated; service registration/load state and pid are reported separately from runtime `/identity` readiness.
- Linux `systemd --user` specifics (#34): one stable per-user unit `rly-gateway.service` under `~/.config/systemd/user` at mode `0600` (directory `0700`); normal `rly init` never requires root and refuses to run as root; the unit uses absolute executable/entrypoint/config paths plus the durable `~/.rly` working directory and appends service stdout/stderr to the durable RLY log directory (`~/.rly/logs/service.log`, journal default otherwise); the unit holds paths only and never credentials, tokens, or account identity, and never uses `Environment=`; crash restart is `Restart=on-failure` with explicit `RestartSec` and a bounded `StartLimitIntervalSec`/`StartLimitBurst` policy so repeated broken startups become a diagnosable `failed` state rather than a tight loop; a reachable user systemd manager (user D-Bus) is required and probed before any mutating operation — sessions without one (containers/minimal distros/WSL variants) fail actionably, and RLY never auto-enables `loginctl enable-linger` because that changes OS account behavior beyond the login lifetime; `daemon-reload` runs only when the definition changed and re-running init repairs stale definitions without duplicate units; unit enabled/active/process state is reported separately from runtime `/identity` readiness.

## Security and privacy

- Direct API credentials may use approved references. Project-owned OAuth credentials use a `0700` store with `0600` atomic files or an approved OS secret backend.
- Credential broker owns explicit import/login/refresh, single-flight, generation CAS, backup, and recovery.
- Managed bridges remain supported where they are more stable than project-owned OAuth.
- Diagnostics may include request ID, route/provider/model identifiers, capability/readiness state, timing, status, and version metadata.
- Diagnostics exclude prompts, responses, credentials, authorization headers, email, and account identity.

## Token counting

Routes declare one quality level: `upstream`, `exact-local`, `conservative-estimate`, or `unsupported`. Conservative estimates are allowed with a safety margin and visible readiness warning; they are never labeled exact.

## Provider sequencing

- Claude Code is the single coding harness; the currently observed compatibility target is `2.1.229`. It becomes a tested baseline only after the Claude Code E2E gate passes.
- A profile name is the canonical user-facing alias (`rly <profile>`). Do not add a separate Alias type.
- Codex CLI is an explicit `rly run codex` escape hatch, not a parallel product UX. The currently observed provisional target is `0.147.0-alpha.6.5`. It becomes a tested baseline only after the Codex E2E gate passes.
- Direct Claude routes: OpenRouter first, DeepSeek second.
- Project-owned Codex OAuth through Claude Code is the first control-plane vertical slice.
- Account metadata, credential records, profiles, pools, health, and policy are first-class product concepts.
- Google Gemini/Code Assist OAuth and Google Antigravity are separate provider integrations.
- OpenCode Go follows the credential-broker and pool foundation.
- Alibaba Token Plan is deferred until after Claude MVP, local-only, feature-gated, and requires explicit terms acceptance.
- Codex runtime and Google Antigravity bridge follow Claude acceptance.
- ClinePass is an explicit interoperability adapter after the first OAuth/pool slice.
- First local UI increment is admin plus diagnostics: providers, accounts, pools, profiles, health/quota, audit, and last-N route traces. Secrets stay out of the browser.
- After the Phase 10 UI/fail-closed slice, provider breadth pauses. Codex OAuth and ClinePass through Claude Code are the current integration targets. ClinePass import stays one-time read-only; continuous Cline store lock/writeback is rejected for V1. Claude subscription OAuth remains implemented as text-only and is parked in `BACKLOG.md` until stream/tools and an owner OAuth-vs-bridge decision exist.

## Non-goals for V1

Remote/multi-user administration, unbounded or post-stream failover, cost/prompt-derived routing, plugin marketplace, silent credential discovery, and persistent global Claude/Codex configuration.
