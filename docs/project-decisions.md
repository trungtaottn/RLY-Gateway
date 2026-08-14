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
- `rly config` is the primary user-facing control plane after `rly init`: it resolves durable configuration from the `~/.rly` installation record (no `gateway.config.toml` in the current working directory on the normal installed path), ensures/reuses the resident runtime (recovering the registered service when it is down and falling back to a session-scoped foreground runtime for uninitialized checkouts), opens the local loopback config UI through the existing single-use fragment bootstrap, and exposes focused provider/account/pool/profile shortcuts over the same management API and policy revision as `rly admin`. `rly init` remains one-time machine/user bootstrap; provider add/re-auth happens from `rly config`.
- macOS LaunchAgent specifics (#33): one stable per-user label `com.rly.gateway` in the current user's `gui/<uid>` launchd domain; `~/Library/LaunchAgents` plist at mode `0600`; normal `rly init` never requires root and refuses to run as root; service stdout/stderr land in the durable RLY log directory (`~/.rly/logs/service.log`); the plist holds absolute executable/state paths only and contains no credentials, tokens, or account identity; crash restart is bounded by an explicit launchd `ThrottleInterval` so repeated broken startups are diagnosable rather than a tight loop; changed/stale definitions are unloaded before reload during init/update; launchctl v2 and legacy subcommands are both tolerated; service registration/load state and pid are reported separately from runtime `/identity` readiness.
- Linux `systemd --user` specifics (#34): one stable per-user unit `rly-gateway.service` under `~/.config/systemd/user` at mode `0600` (directory `0700`); normal `rly init` never requires root and refuses to run as root; the unit uses absolute executable/entrypoint/config paths plus the durable `~/.rly` working directory and appends service stdout/stderr to the durable RLY log directory (`~/.rly/logs/service.log`, journal default otherwise); the unit holds paths only and never credentials, tokens, or account identity, and never uses `Environment=`; crash restart is `Restart=on-failure` with explicit `RestartSec` and a bounded `StartLimitIntervalSec`/`StartLimitBurst` policy so repeated broken startups become a diagnosable `failed` state rather than a tight loop; a reachable user systemd manager (user D-Bus) is required and probed before any mutating operation — sessions without one (containers/minimal distros/WSL variants) fail actionably, and RLY never auto-enables `loginctl enable-linger` because that changes OS account behavior beyond the login lifetime; `daemon-reload` runs only when the definition changed and re-running init repairs stale definitions without duplicate units; unit enabled/active/process state is reported separately from runtime `/identity` readiness.

## Security and privacy

- Direct API credentials may use approved references. Project-owned OAuth credentials use a `0700` store with `0600` atomic files or an approved OS secret backend.
- Credential broker owns explicit import/login/refresh, single-flight, generation CAS, backup, and recovery.
- Managed bridges remain supported where they are more stable than project-owned OAuth.
- Diagnostics may include request ID, route/provider/model identifiers, capability/readiness state, timing, status, and version metadata.
- Diagnostics exclude prompts, responses, credentials, authorization headers, email, and account identity.

## Claude configuration overlay (#74)

- The historical throwaway `CLAUDE_CONFIG_DIR` temp directory (which proved RLY never mutates global Claude files but also threw away user settings/agents/plugins and all RLY session history) is replaced by a **durable RLY-owned Claude configuration namespace** under the durable RLY home: `<control-plane>/claude` (`~/.rly/claude` by default), `0700` directories and `0600` atomic files.
- **Asymmetric ownership is the invariant**: native Claude config (`~/.claude` or the parent `CLAUDE_CONFIG_DIR`) is read/compose-only INPUT; RLY gateway/model state is written only inside the RLY namespace. RLY never overwrites native `settings.json` (model key included), credentials, plugin metadata, history, or agent files as part of launch/exit — including any “save old global model, rewrite it back” logic (unsafe under concurrent sessions).
- Composition is a typed allowlist pinned to the supported Claude Code baseline (currently `2.1.229` through #24): `settings.json` one-way merge (gateway-conflict `env` keys stripped; unrelated settings and the native `model` stay user input; a persisted RLY-only `claude-rly-*` projection model is RLY-owned state and wins on re-compose), user `agents/*.md`, `commands/*.md`, and `skills/**` one-way refresh copies, and `plugins/config.json` enablement declaration only (`enabledPlugins`/`marketplaces`; `oauthAccounts`/token-like keys and plugin cache/repos are never copied — plugin runtime state stays native, a documented difference). Unknown files, `history`, `projects`, `shell-snapshots`, `todos`, `statsig`, and `version` are never copied. `~/.claude.json` (home level) and project-local `.claude` are never touched.
- Refresh is deterministic and race-safe: a file composes when missing or when native is newer; unchanged native input is not rewritten, so sibling RLY sessions' `/model` writes into the shared overlay survive; native deletions are not propagated; malformed native JSON surfaces are skipped, never rewritten or failed over. RLY's own writes are atomic (temp + rename), so concurrent RLY launches converge without locks.
- RLY gateway URL/token/model projection state is child-env only (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`) and is never persisted into overlay settings/history; no RLY launch/management/provider credential secret enters the overlay.
- RLY session/history state under the overlay is durable across RLY launches instead of being deleted at every child exit.
- The rule against permanent global Claude/Codex configuration mutation is **retained** and now has an explicit overlay-based mechanism behind it.
- `rly status` reports overlay paths/version/composition status only; no settings, agent prompts, plugin content, session transcripts, or credentials.

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
