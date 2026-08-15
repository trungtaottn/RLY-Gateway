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

## Model tiers

- Logical tiers (`haiku`/`sonnet`/`opus`/`fable`) are portable model classes resolved **inside the current execution context**: access provider first, then the parent model's model family when that provider exposes multiple families, then trusted capability evidence (#69). `fable` is never a hardcoded global alias for one vendor/model and never "the strongest model across all authenticated providers".
- Tiers are not upstream model ids: an exact physical model request keeps the exact #68 path. Tiers resolve only to eligible trusted models under the current provider/family by default; cross-family and cross-provider fallback are explicit, trace-visible policies that are disabled by default.
- Effective tier mappings are stable for an active session/policy revision: the built-in reviewed mapping and per-profile overrides are immutable per revision, and catalog refresh (#23) proposes better mappings without silently changing trusted tier mappings.
- Existing `primary`/`fast`/`reasoning` profile roles remain unchanged; tier resolution is a parallel path for portable tier aliases (`model: fable`), and `profile.modelRoles` additionally accepts tier keys as per-profile user overrides (validated fail-closed through #68 exact evidence).

## Model intent and selector namespaces (#125)

- The incoming model selector is classified into one typed `ModelIntent` (`EXACT_PROJECTION`, `RLY_LOGICAL_TIER`, `CLIENT_NATIVE_ALIAS`, `EXACT_CLIENT_MODEL`, `INHERIT`, `DEFAULT`) before any routing, with exact source-selector provenance preserved for diagnostics. Core invariant: **`fable != rly-tier:fable`** — the client-native alias vocabulary (owned by Claude/Codex) is a different namespace from RLY's logical selector namespace.
- RLY logical tiers are addressed only through the explicit `rly-tier:<tier>` namespace; a selector claiming the namespace with an unknown value fails closed (`unknown-namespace`) and is never silently reinterpreted as an alias/exact model. Bare tier strings are never RLY policy selectors by string equality.
- Bare client-native aliases keep working for existing agent/skill files (`model: fable`) without rewriting them to physical provider model ids: they map to the equivalent RLY tier through the explicit, traceable client-alias contract, then the #69 provider/family resolver runs unchanged. The classification is deliberate and visible in the route trace (`kind`/`source`), never string equality.
- The #69 tier resolver is invoked **only** for an explicitly typed tier intent — never through accidental string matching. Exact projected selection (#72) remains exact and is dispatched before profile resolution; persisted exact model ids keep the exact #68 path and are never reinterpreted as tiers.
- Precedence is deterministic and documented (explicit `rly-tier:` → projection → client alias → inherit → default → exact model); conflicting selector sources and namespace errors have a typed failure taxonomy mapped onto the existing profile error contract. Diagnostics expose selector kind/source/resolved target only — never prompts, credentials, account identity, or settings contents.

## Native protocol rails and fidelity envelope (#119)

- RLY is a protocol-preserving gateway first and a model router second. Same-protocol traffic keeps the native encoder/decoder wire shapes as the source of wire truth; RLY patches only RLY-owned controls (selected model/auth/endpoint). The semantic core (`CanonicalRequest`/`CanonicalEvent`) stays the routing/capability/tool/reasoning/diagnostics projection and never becomes the only source of truth for provider/client-owned opaque continuation state.
- A versioned **fidelity envelope** (`src/core/fidelity.ts`, version 1) carries typed opaque continuation artifacts (kind, stable item/block association, value), translation provenance (`preserved-native`/`translated`/`ignored`/`unsupported`), and the artifact kinds a compatibility claim requires. Adapters/protocol codecs may preserve opaque artifacts; routing policy inspects only explicitly modeled safe metadata (kind, association, disposition), never artifact values.
- Anthropic thinking `signature` (and streaming `signature_delta`, ordered relative to thinking/content events) is preserved natively into the envelope and onto the aggregate thinking block; a required signature on a path that cannot represent it fails closed (`unsupported-fidelity`) — nothing is fabricated, decrypted, or silently dropped.
- OpenAI Responses reasoning item identity is semantic (non-secret) and opaque `encrypted_content` is an envelope artifact retained with the exact item association across decode → continuation storage → subsequent `previous_response_id` request construction → re-encode; opaque content is never reconstructed from summary text.
- Unknown additive native fields are recorded as intentionally ignored with provenance, not silently treated as required continuation state. Opaque artifact kinds stay a typed extension point (Gemini/OpenRouter/DeepSeek) so canonical routing does not need redesign for future provider-owned artifacts.
- Opaque artifact values are runtime/protocol state, never diagnostics: they are never logged, never in route traces, never in diagnostic bundles, and are redacted by the observability redactor; `describeFidelity()` exposes provenance metadata only. Continuation persistence applies the existing private-file/storage rules.

## Subagent model resolution (#71)

- Claude Code orchestrates agents; RLY resolves their requested execution target and reasoning safely. RLY never inspects prompts to infer task type and never becomes a workflow engine — it responds only to explicit agent/tier/effort signals (`X-Claude-Code-Session-Id`, `X-Claude-Code-Agent-Id`, `X-Claude-Code-Parent-Agent-Id` and the portable `model: fable`/effort request).
- A subagent's tier resolves inside its parent agent's execution context: the session-scoped, lease-bound registry records each agent's frozen physical model/family after successful resolution, and the subagent inherits that context (exact parent match → session main context → unambiguous launch-session profile default). No global strongest-model search and no cross-provider/family substitution: an undeterminable family fails closed (`family-unknown` → `tier-unavailable`).
- The parent/main session's model, profile mapping, and global Claude settings are never mutated by subagent execution; concurrent subagents with different agent ids resolve independently under one launch session.
- No global `CLAUDE_CODE_SUBAGENT_MODEL` override exists; the source agent/skill definition (`model: fable`) is never rewritten to a physical model. The supported client baseline's native `fable` alias behavior is classified by #24 canaries.
- Agent attribution is runtime data, not authorization; launch/gateway tokens keep the security boundary. Traces carry only hashed agent linkage pseudonyms; credentials, prompts, and durable user identity never enter diagnostics.

## Gateway model discovery and projection (#72)

- RLY exposes the configured, trusted model universe to Claude Code through authenticated `GET /v1/models` on the gateway listener using the supported Anthropic Messages discovery wire contract. Discovery is a **presentation + exact-target selection surface**: #67 remains canonical evidence, #69 remains contextual tier resolution, #23 refresh stays propose-only and never mutates projections, and the account selector remains the account/credential authority.
- Every discoverable id uses the Claude-compatible `claude-rly-...` namespace (the supported client only adds ids beginning with `claude`/`anthropic`). Ids are transport/user-selection handles only; an explicit reverse mapping resolves each id to one exact access-provider/model target and provider pool, and routing never parses id strings or derives security decisions from them.
- A model is discoverable only when its access provider is enabled in the active policy, the session has an explicit provider→pool route for that provider (the profile's own pool, or a single eligible default pool per provider — RLY never picks an arbitrary pool), the model has trusted registry evidence, and compatibility is `VERIFIED` by default (`EXPERIMENTAL` requires the explicit `gateway.modelDiscovery.experimentalModels` config opt-in; `BROKEN`/unreviewed never).
- The same upstream model through two access providers appears as two distinct selectable targets (distinct ids/display labels) because auth/pool/endpoint/terms are different execution paths.
- Each launch session pins its model-universe snapshot (policy revision/hash, registry revision, provider→pool bindings, experimental policy) at issue time; a registry/policy change during an active session never silently remaps an already-issued projection id, and removed/broken targets fail explicitly rather than substitute another model.
- An RLY-only projection selected via `/model` persists only inside the RLY overlay; `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` is child-env only, and a plain `claude` launch never inherits RLY discovery env, auth, or projection ids (see Claude configuration overlay above).

## Safe zero-downtime runtime update (#73)

- Installation and activation are deliberately separate durable states: `rly update` may install a verified candidate while the old resident runtime keeps serving existing Claude Code sessions; an installed candidate is never considered active until the restarted runtime passes authenticated identity/readiness/state-open verification.
- The serving runtime's `/identity` reports its actual runtime version, durable state/schema version, update state, active launch-session count, and drain flag through the attested handshake; the package/CLI version on disk is never proof of what is serving.
- The normal update path waits for a safe zero-active-session drain point (launch-session count, not TCP connections) before restarting; existing sessions always keep running on the old process unless the user explicitly requests the destructive `--force` path. Once drain begins, the old runtime refuses new launch-session issuance.
- New launches while activation is pending follow a deterministic compatibility policy: a compatible CLI/runtime pair may continue on the old runtime; an incompatible pair refuses only NEW launches with an actionable `update-pending`/`runtime-version-mismatch` message. `status`/`doctor` show installed-but-not-activated state.
- Activation restarts only attested resident runtimes through the per-user service manager (#33/#34 `restart()`); launcher-owned instances are never updated/restarted. A forward-only/unrollbackable candidate migration blocks activation before any destructive state change.
- On activation failure RLY rolls back once to the preserved previous known-good version and verifies the rollback; if both fail it stops with a deterministic doctor message. Never loop restart/rollback; never signal a process from port occupancy alone.
- Concurrent `rly update` invocations serialize through an ownership-aware stale-reclaimable update lock; crash/reboot states (interrupted install, pending activation, interrupted activation, stale lock) recover deterministically.
- Distribution/signing is #35 (BACKLOG): #73 owns the lifecycle once a candidate is obtained/verified; update state, artifacts, and logs are secret-free (versions/timestamps only, never credentials, tokens, prompts, responses, or account identity).

## Runtime compatibility canary (#24 / BL-043)

- The canary is the runtime compatibility evidence gate: it reports exact installed client versions separately from binary `found` state (`src/targets/versions.ts`; version parsed from `--version` output only, never inferred from timestamps/paths), pins the supported baseline's wire contract with redacted fixtures, runs a deterministic fake gate matrix per exact access path, and classifies each path `VERIFIED`/`EXPERIMENTAL`/`BROKEN`/`unknown`. A newly installed unknown client version produces a visible `unknown/not-tested` status and does not silently replace the tested baseline; binary presence is never compatibility.
- The pinned fixture baseline is `claude-code-2.1.229`. The observed local client `2.1.231` and Codex `0.147.0-alpha.6.5` are recorded as observed and are not tested baselines until the corresponding evidence gate passes.
- `VERIFIED` requires every required gate for the advertised RLY use of that exact access path to pass AND live evidence where the provider class requires it (Codex OAuth, ClinePass, direct OpenRouter/DeepSeek). Fake-only evidence classifies `EXPERIMENTAL` at most; a failed required contract is `BROKEN`; missing/unrun evidence is `unknown` and never reported as passed.
- Evidence is keyed by exact client kind/version + access provider + adapter/integration path + physical model; the same upstream model through two access providers never shares evidence. Capability-dependent gates stay `not-run` without reviewed evidence, so tool/reasoning capabilities are never advertised stronger than proven.
- `rly canary run` emits secret-free machine-readable evidence artifacts under `<control-plane>/canary/` for #23/#67 review tooling; the canary reports evidence and drift and never mutates `directProviderRegistry`, trusted tier mappings, or `/v1/models` projection. Promotion of proposed compatibility state remains an explicit reviewed control-plane action.
- The #72 projection gate consumes canary-derived compatibility state: `VERIFIED` by default, `EXPERIMENTAL` only with the explicit `gateway.modelDiscovery.experimentalModels` opt-in, `BROKEN`/unreviewed never.
- `rly doctor` reports installed client versions, the tested baseline, and the live-gate env; canary diagnostics/artifacts carry client/provider/model ids, gate names, status, fixture revision, and redacted error categories only — never prompts, responses, reasoning text, credentials, or account identity.

## Token counting

Routes declare one quality level: `upstream`, `exact-local`, `conservative-estimate`, or `unsupported`. Conservative estimates are allowed with a safety margin and visible readiness warning; they are never labeled exact.

## Provider sequencing

- Claude Code is the single coding harness; the currently observed compatibility target is `2.1.229` (protocol fixtures) with the observed local client `2.1.231` (#71). Neither is automatically a tested baseline: the pinned fixture baseline is `claude-code-2.1.229` and it becomes a tested baseline only through the #24 canary evidence gate (fake matrix + any required live gate). A newly installed Claude Code version reports `unknown/not-tested` and never silently replaces the tested baseline.
- A profile name is the canonical user-facing alias (`rly <profile>`). Do not add a separate Alias type.
- Codex CLI is an explicit `rly run codex` escape hatch, not a parallel product UX. The currently observed provisional target is `0.147.0-alpha.6.5`; it is recorded as observed, NOT a tested baseline, until the Codex E2E gate and #24 evidence pass.
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
