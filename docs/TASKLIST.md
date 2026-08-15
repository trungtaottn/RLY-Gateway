# RLY Gateway Tasklist

This file is the concise committed-work view. Detailed steps, risks, and acceptance evidence live in the [active implementation plan](../plans/260813-1239-claude-first-personal-gateway/plan.md).

## Completed milestones: Bootstrap through Claude direct-provider MVP

- [x] Create clean `rly-gateway` Git repository on `main`.
- [x] Move plan, research, scout, and architecture counsel into the project.
- [x] Approve product identity, stack, privacy, bridge, and token-count defaults.
- [x] Record protocol, bridge, and lifecycle ADRs.
- [x] Create project authority documents: SPEC, TASKLIST, BACKLOG, roadmap, architecture, tech stack, onboarding.
- [x] Reconcile Phase 01 external Claude runtime-state drift by excluding volatile state from deterministic config invariants.
- [x] Complete Phase 01 retest and independent review with bounded historical claims.
- [x] Initialize the TypeScript/Node/pnpm foundation with lockfile, lint, tests, build, CI, SECURITY, and provenance.
- [x] Implement bootstrap config schema, environment credential references, redaction, capability preflight, and immutable routing contracts.
- [x] Implement minimal authenticated loopback liveness/readiness/identity server plus `status` and `doctor` CLI.
- [x] Complete atomic ownership persistence, startup locks, leases, launcher child-process injection, and signal forwarding.
- [x] Pass foundation unit, lifecycle, privacy, lint, typecheck, build, and privacy-scan gates.

## Completed milestone: Anthropic protocol fidelity

- [x] Define canonical request/event tagged unions, including the OpenAI
  Responses source identity boundary.
- [x] Implement loss-aware Anthropic request decoding and capability preflight.
- [x] Implement streaming/non-streaming Anthropic response encoding.
- [x] Implement declared token-count quality behavior.
- [x] Add redacted contract coverage for text, images, tools/results, thinking,
  usage, stop reasons, and tool-argument deltas.
- [x] Pass fake-upstream route integration and retry-boundary coverage.

Implemented protocol behavior is documented in
[protocol compatibility](./protocol-compatibility.md). This milestone does not
make an Anthropic route operational in the runtime gateway or establish Claude
Code/live-provider compatibility.

## Completed milestone: Claude direct-provider MVP

- [x] Add OpenRouter adapter and model capability evidence.
- [x] Add DeepSeek adapter and reasoning replay behavior.
- [x] Add explicit model-role mapping.
- [x] Pass real Claude Code fake-upstream E2E.
- [x] Pass one explicit live direct-provider smoke.

## Completed milestone: Authority and source freeze

- [x] Accept self-owned control plane, OAuth credentials, explicit import, and account pools.
- [x] Supersede the bridge-only credential restriction.
- [x] Define request-time eligibility, selection, and immutable EffectiveRoute.
- [x] Pin exact source artifacts, hashes, licenses, and module adaptation matrix.
- [x] Prove CLIProxy Plus provenance separately from CCS.
- [x] Create sanitized compatibility fixtures for copied behavior.

## Completed milestone: Control-plane foundation

- [x] Versioned SQLite schema and atomic migrations with backup/restore.
- [x] Authenticated management listener on `127.0.0.1:17872` with Origin/CSRF, separate bearer, and fragment bootstrap.
- [x] Secret-free DTOs, policy revision compilation, and metadata-only audit.
- [x] CLI administration for create/list/update and account pause/resume.
- [x] Security, race, corruption, and recovery tests. Evidence: `pnpm verify` — 114 passed, 6 skipped.

## Completed milestone: Credential broker and Codex OAuth

- [x] Project-owned credential store with `0700`/`0600`, atomic replace, backup, and recovery.
- [x] Explicit read-only Codex import that leaves the source store unchanged.
- [x] Project-owned PKCE login, single-flight refresh, generation compare-and-swap, and revoke.
- [x] Manual account select/pause/revoke with secret-free readiness.
- [x] Codex OAuth adapter receives request-scoped secrets and binds one account into the Anthropic route.
- [x] Credential, OAuth, recovery, privacy, and contract tests. Evidence: `pnpm test` — 134 passed, 7 skipped; `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test:privacy` passed.

## Completed milestone: Deterministic account pools

- [x] Eligibility engine filters pause, expiry, auth readiness, quota class, cooldown, capabilities, terms, and generation.
- [x] Manual pin, round-robin, fill-first, bounded session affinity, and evidence-backed quota ordering.
- [x] Immutable EffectiveRoute binds one account pseudonym and credential generation.
- [x] Outcome/cooldown updates are transactional; rotation is blocked after the first output or tool event.
- [x] Race, crash-rollback, and restart gates. Evidence: `pnpm verify` — 153 passed, 7 skipped.

## Completed milestone: Claude integration and profile UX

- [x] Profile activation selects policy, not an account.
- [x] `run claude --profile` issues a lease-scoped child token.
- [x] Anthropic requests through a profile use request-time pool eligibility.
- [x] Helper-role mapping stays inside the selected profile.
- [x] Status, doctor, quota, and route-trace stay secret-free.
- [x] Fake pool-profile Claude E2E is gated; live Codex pool smoke is opt-in.
- [x] Doctor does not open or migrate the control-plane store.

## Later committed V1 milestones
- [x] Secret-free local UI and provider expansion. Evidence: `pnpm verify` including `pnpm test:browser`; create-time catalog reject; Cline endpoint policy; Gemini/Antigravity live smokes opt-in skipped. Claude OAuth stays in BACKLOG.
- [x] OpenAI Responses and Codex CLI E2E. Evidence: `tests/contract/openai-responses/responses.test.ts`, `tests/e2e/codex/fake-upstream.e2e.test.ts`, `run codex` isolation in `tests/lifecycle/global-config-isolation.test.ts`.
- [x] Release hardening, packaging, provenance, migration, recovery, and daily workflow gates. Evidence: `pnpm test:release`, `tests/storage/retention.test.ts`, existing migration/crash suites plus license/package/clean-install scripts.
- [x] Release-lane automation and post-Stable alignment. Evidence: `tests/unit/release-automation.test.ts`, `.github/workflows/release-beta.yml`, `.github/workflows/release-stable.yml`; Slack delivery requires the repository `SLACK_WEBHOOK_URL` secret and the documented GitHub Actions ruleset bypass.

## Completed milestone: Phase 1 core correctness

- [x] Provider-scoped account identity `(provider_id, pseudonym)` with fail-closed credential/provider mismatch (#55).
- [x] Crash-recoverable credential locks using ownership-aware pid/start-identity reclaim (#57).
- [x] Refresh before immutable EffectiveRoute; invoke binds the frozen generation (#56).
- [x] Recoverable quota/cooldown: exhausted is a probe after cooldown; success restores healthy (#58).

## Completed milestone: Phase 2 profile alias

- [x] `rly <profile>` launches Claude Code with that profile (#54).
- [x] Reserved commands stay reserved; unknown profile fails closed; `rly run codex` remains Codex CLI.
- [x] No global Claude/Codex configuration mutation. Evidence: `tests/unit/cli-main.test.ts`, `tests/lifecycle/global-config-isolation.test.ts`; `pnpm verify` — 232 passed / 10 skipped; AT-031 browser passed.

## Completed milestone: Phase 3 Codex through Claude Code

- [x] Operator recipe for `codex` provider → login/import → pool → Claude profile named `codex` → `rly codex` (#1).
- [x] Fake-upstream Claude Code E2E through Codex OAuth for text, streaming, tools, and cancellation (#2). Helper mapping, quota rotation, and sticky session use the existing pool path. Gated `RLY_CLAUDE_E2E=1`; skipped ≠ pass.
- [x] Opt-in live Claude Code → gateway → Codex OAuth smoke (#3). Gated `RLY_LIVE_CODEX_OAUTH=1`; skipped ≠ pass.
- [x] Exact `(providerId, modelId)` Codex helper evidence; unknown required capability fails closed; no DEFAULT_CAPABILITIES fallback (#4).
- [x] Secret-free `quota`/`route-trace` for a Codex profile: pseudonym, quota class, and decision reason only (#5).

## Completed milestone: Phase 4 ClinePass through Claude Code

- [x] Operator recipe for `cline` provider → explicit preview+import with `providerId` → pool → Claude profile named `clinepass` → `rly clinepass` (#8). Preview without `providerId` stays rejected. Import does not write the Cline store.
- [x] Fake-upstream Claude Code E2E through `cline-interop` for text and tools (#9). Cline failure does not mutate Codex credential files. Gated `RLY_CLAUDE_E2E=1`; skipped ≠ pass.
- [x] Opt-in live Claude Code → gateway → ClinePass smoke (#10). Gated `RLY_LIVE_CLINEPASS=1`; skipped ≠ pass.
- [x] Exact `(cline, claude-sonnet-4-5)` helper evidence; missing/cross-provider evidence fails closed; no DEFAULT_CAPABILITIES fallback.
- [x] Supersede continuous Cline store lock/backup/restore as default (#11). One-time read-only import remains. Helpers stay unwired.

## Completed milestone: Phase 1 persistent runtime service

- [x] Resident ownership on the existing attested loopback gateway: a service-owned lease renewed by the resident process keeps the runtime alive after the last launch lease; no second daemon/data plane (#65).
- [x] `rly init` settles the durable `~/.rly` home, validates the control-plane store, registers the per-user service idempotently (macOS LaunchAgent / Linux `systemd --user`), starts it, and waits for an attested compatible resident runtime.
- [x] `rly gateway start|stop|status` service commands; explicit stop uses an attested authenticated in-process `/shutdown` (revoke sessions, bounded close, broker/control-plane close, artifact cleanup). Foreign listeners are never signaled.
- [x] Identity/version handshake: `/identity` carries `runtimeVersion` + `resident`; `status` distinguishes compatible resident, incompatible/stale, and foreign states.
- [x] Crash/stale recovery reuses startup-lock and process-identity rules; launcher-owned instances are never killed or reused by the service.
- [x] Docs aligned (SPEC, project-decisions, BACKLOG, ARCHITECTURE, ROADMAP, ADR 0003/0006, RTM, AT catalogue); FR-018/SR-F-022/AT-034 added. Evidence: `tests/lifecycle/resident-runtime.test.ts`, `tests/service-manager/*`, `tests/unit/cli-init.test.ts`, `tests/unit/cli-gateway.test.ts`; `pnpm verify` green.

## Completed milestone: Phase 23 catalog proposal — propose-only provider catalog refresh (#23)

- [x] Provider-owned catalogue discovery contract: `ProviderCatalogSource` (`src/providers/catalog-discovery.ts`) returns a normalized `DiscoverySnapshot` without registry mutation access; OpenRouter API path (`GET /models`, explicit id/family normalization, optional env-ref auth, privacy-redacted errors) and static reviewed-list path.
- [x] Deterministic drift engine: `proposeCatalogDrift()` (`src/registry/catalog-proposal.ts`) reports unchanged/new/changed/removed + reviewed `compatibilityEvidenceRefs`, sorted stably; identical trusted registry + identical snapshot yield a stable unchanged proposal; 250-model aggregator snapshots stay deterministic and activate nothing; mixed-provider/duplicate snapshots fail closed; same upstream id across providers never cross-matches.
- [x] Provider-reported capabilities are labeled declared/observed; nothing is promoted to trusted evidence by discovery; #24 references come from reviewed entries only (skipped canary never = pass).
- [x] Persistence separate from trusted evidence: `ProposalStore` (`src/registry/proposal-store.ts`) writes schema-validated metadata-only artifacts under `<control-plane>/proposals/<provider>.json`; malformed artifacts fail closed on read.
- [x] CLI surface: `rly admin models refresh --provider <name> [--source api|static] [--snapshot <file>] [--family <f>]` and `rly admin models proposals`; proposals are surfaced with `trusted: false` and never as selectable/usable models; refresh requires no management listener and cannot change trusted evidence, tier mappings, or `/v1/models` projection.
- [x] Docs/RTM/AT: AT-036/AT-037 added; ARCHITECTURE, SPEC §6.2, BACKLOG BL-042, TASKLIST updated. Evidence: `tests/unit/catalog-proposal.test.ts`, `tests/contract/providers/catalog-discovery.test.ts`, `tests/unit/proposal-store.test.ts`, `tests/unit/cli-admin.test.ts`; `pnpm verify` green.

## Completed milestone: Phase 33 macOS launchd service adapter (#33)

- [x] macOS LaunchAgent adapter hardening on the #65 contract: launchctl v2 `bootstrap`/`kickstart`/`bootout`/`print` with legacy `load`/`start`/`unload`/`list` tolerance; no-root guard; `0600` plist + `0700` LaunchAgents dir; atomic plist replace; changed-definition repair unloads before reloading; explicit bounded `ThrottleInterval`; `WorkingDirectory` + `StandardOut/ErrPath` into the durable RLY log dir (`~/.rly/logs/service.log`); `restart()` (`kickstart -k`) for the #73 controlled restart path; `detail()` reports label/load state/pid separately from runtime `/identity` readiness.
- [x] `rly init` passes the durable log/working paths into the adapter; `rly gateway status` and `rly status` report service label/load state/pid on macOS; no credential/token/account identity ever enters the plist.
- [x] Fake-runner unit tests for commands, repair reload, legacy fallback, status/pid parsing, root refusal, secret absence, working-dir/log plist; opt-in macOS live smoke (`RLY_LIVE_LAUNCHAGENT_SMOKE=1`, skipped ≠ pass); docs/RTM/AT updated (AT-036, FR-018 macOS specifics). Evidence: `tests/service-manager/definitions.test.ts`, `tests/service-manager/adapters.test.ts`, `tests/service-manager/launch-agent-live.test.ts`, `tests/unit/cli-init.test.ts`, `tests/unit/cli-gateway.test.ts`; `pnpm verify` green.

## Completed milestone: Phase 34 Linux systemd user service (#34)

- [x] Linux `systemd --user` adapter on the #65 contract: one per-user `rly-gateway.service` under `~/.config/systemd/user` (`0600` unit, `0700` dir, atomic replace); no-root guard; user-manager bus probe before any mutating op with an actionable no-user-manager error (containers/minimal distros/WSL guidance, deliberate no `loginctl enable-linger`); `Restart=on-failure` + explicit `RestartSec` and bounded `StartLimitIntervalSec`/`StartLimitBurst`; `WorkingDirectory` (`~/.rly`) + `StandardOutput/Error=append:` into the durable RLY log dir (`~/.rly/logs/service.log`); change-only `daemon-reload` with idempotent stale-definition repair; `start` (`enable --now`), `restart()` for the #73 controlled-restart path, stop tolerating not-loaded; `detail()` parses `systemctl --user show` into registered/loaded/running/pid/enabled/activeState, failed state surfaced, unreachable manager never reports loaded; unregister `disable --now` + removes only the RLY unit; no `Environment=` and no credential/token/account identity ever enters the unit.
- [x] `rly init` passes the durable log/working paths into the adapter; `rly gateway status` and `rly status` report service label/load state/pid/enabled on Linux; no credential/token/account identity ever enters the unit.
- [x] Fake-runner unit tests for commands, change-only reload, repair, status/pid/enabled parsing, no-user-manager actionability, root refusal, secret absence, working-dir/log unit, unregister safety; opt-in Linux live smoke (`RLY_LIVE_SYSTEMD_SMOKE=1`, skipped ≠ pass); docs/RTM/AT updated (AT-040, FR-018 Linux specifics). Evidence: `tests/service-manager/definitions.test.ts`, `tests/service-manager/adapters.test.ts`, `tests/service-manager/systemd-user-live.test.ts`, `tests/unit/cli-init.test.ts`, `tests/unit/cli-gateway.test.ts`; `pnpm verify` green.

## Completed milestone: Phase 67 model foundation — provider model intelligence registry

- [x] Canonical model evidence distinguishes access provider, exact upstream model id, and upstream/model family where known; one aggregator provider exposes many families without parallel registries (#67).
- [x] Same upstream model id through two access providers stays two separate entries; exact lookup fails closed for missing/cross-provider evidence.
- [x] Existing `ProviderCapabilities` evidence preserved and extended with typed reasoning/limit metadata; compatibility state (`VERIFIED`/`EXPERIMENTAL`/`BROKEN`) is typed and separate from raw capability support with baseline/evidence/check-date provenance.
- [x] Deterministic query helpers (provider-scoped, family-scoped, capability predicate, compatibility filtering) with no account selection or credential access (#68/#69).
- [x] Discovery→proposal boundary: `proposeRegistryChanges()` returns proposed candidates without mutating the trusted registry; #23 propose-only behavior enforced by tests.
- [x] Registry revision bumped 3→4 with migration for static legacy documents; `ProviderRecord.capabilityEvidence` typed (was `unknown`) and schema-validated at the management boundary and row parse.
- [x] Docs/RTM/AT identify the registry as the source of truth for #68-#72 and explain evidence ownership (reviewed vs discovered vs #24 canary). Evidence: `pnpm verify` — see PR.

## Completed milestone: Phase 68 capability based model selection (#68)

- [x] Deterministic model capability matching engine (`src/routing/model-selection/`): data-only `ModelSelectionInput` (access provider, preferred family, exact pin, required capabilities, reasoning intent, experimental opt-in), one frozen `ModelEvidence` result plus a secret-free decision trace.
- [x] Hard eligibility before ranking: trusted registry evidence only; existing `CapabilityRequirement` semantics; reasoning semantics from `ReasoningCapabilityEvidence` (required + reasoning-with-tools); compatibility state (`BROKEN` always rejected, `EXPERIMENTAL` rejected by the default normal-user candidate policy, explicit opt-in or an exact pin to enable).
- [x] Deterministic ranking in reviewed registry document order with stable tie-break; no invented quality scores; no cost/latency activation (#32 stays inert); typed failure taxonomy (`unknown-exact-model`, `no-trusted-evidence`, `capability-unsupported`, `reasoning-unsupported`, `compatibility-rejected`, `no-eligible-candidate`) mapped onto the existing `capability-rejected` profile error contract with the actionable reason attached.
- [x] Two-stage boundary: `resolveProfileRoute` selects the physical model before `RouteSelector` account selection; the model is frozen in the effective request/route; account failover cannot change it; `/v1/route-traces` carries the model-selection decision beside the account decision.
- [x] Exact physical model path preserved: exact pins resolve to the exact registry entry without rerouting and still validate capabilities/compatibility; existing Codex/Cline/profile-pool route behavior unchanged.
- [x] Docs/RTM/AT: ARCHITECTURE two-stage boundary section, AT-044–AT-047 added, RTM Phase 68 evidence rows, TASKLIST milestone entry. Evidence: `tests/unit/model-selection.test.ts`, `tests/lifecycle/profile-pool-route.test.ts`, existing registry/router/lifecycle suites; `pnpm verify` green (see PR).

## Completed milestone: Phase 69 provider/family-scoped model tier resolver (#69)

- [x] Logical tier semantics (`haiku`/`sonnet`/`opus`/`fable`) typed separately from physical model ids; tiers express a portable model class inside a provider/model-family context and never a global fixed mapping or a strongest-across-providers search.
- [x] `TierResolutionContext` (access provider + parent model/model family + explicit user mapping + explicit fallback flags) and a deterministic resolver (`src/routing/model-tiers/`) with search order: explicit user mapping → reviewed/default mapping → deterministic #68 candidate evaluation in the same provider+family → explicitly enabled fallback scopes; fail-closed `tier-unavailable`/`family-unknown`/`override-rejected`/`mapping-invalid` on absence, never silent substitution.
- [x] Frozen reviewed default tier mapping (revisioned) covering the owner-approved ClinePass fixtures; per-profile user overrides via `profile.modelRoles` tier keys through the existing management surface; effective mapping stable per session/policy revision; catalog refresh (#23) never mutates trusted tier mappings.
- [x] Wired through the profile pipeline: `model: fable` resolves against the pool provider + parent model family, then feeds #68 exact selection, #70 reasoning, and the existing account selector; `activateProfile` accepts pre-resolved tier targets; `ProfileDecisionTrace.tierResolution` carries secret-free tier metadata (requested tier, provider/family context, target, mapping source, fallback reason).
- [x] Registry evidence extended with ClinePass aggregator tier fixtures (Terra/Sol, DeepSeek V4 Pro, Anthropic Opus/Fable) in the same canonical shape; no auto-activation of proposed/unreviewed models.
- [x] Docs/RTM/AT: ARCHITECTURE tier resolution section, project-decisions tier semantics, protocol-compatibility logical tier aliases, BACKLOG BL-042 wording, AT-057–AT-064 added, RTM Phase 69 evidence rows, TASKLIST milestone entry. Evidence: `tests/unit/tier-resolver.test.ts`, `tests/lifecycle/cline-profile-route.test.ts`, `tests/lifecycle/profile-pool-route.test.ts`, `tests/unit/profiles.test.ts`, `tests/control-plane/repositories.test.ts`; `pnpm verify` green (see PR).

## Completed milestone: Phase 70 provider-neutral reasoning intelligence layer (#70)

- [x] Canonical reasoning contract (`src/core/reasoning.ts`): provider-neutral semantic intents `OFF`/`ECONOMY`/`BALANCED`/`DEEP`/`MAXIMUM`/`AUTO` plus source fidelity (`sourceMode`/`sourceEffort`/`explicit`); `CanonicalRequest.inference.reasoning` added beside the legacy `thinking` source-mode view.
- [x] Decoder fidelity from the pinned supported-baseline shape (`tests/fixtures/upstream/claude-code/reasoning-shape.json`): Anthropic `thinking.type` continued; documented additive `effort` preserved as `sourceEffort`; unknown additive fields recorded as ignored; OpenAI Responses `reasoning.effort` preserved instead of collapsed to a boolean.
- [x] Provider-owned translation boundary (`src/providers/reasoning.ts`): deterministic `resolveReasoning(request, capability)` maps canonical intent onto the selected model's `ReasoningCapabilityEvidence` control kind (discrete effort with exact same-family effort preservation, binary, adaptive, token-budget via reviewed per-model policy only, unsupported); every non-exact mapping records `mappingKind` (`exact`/`normalized`/`downgraded`/`default`) + `fallbackReason`; explicit unsupported intents fail closed (`unsupported-reasoning`/`no-budget-policy`) unless an explicit best-effort policy downgrades with a recorded reason; never a universal hardcoded token number.
- [x] Routing wiring: translation result rides `RouteRecord`/`RouteDecision`/`EffectiveRoute` (registry-backed evidence), `resolveProfileRoute` computes it before account selection, direct/TOML routes via `createDirectRouteResolver`; `ProfileDecisionTrace.reasoning` carries allowlisted requested/canonical/effective/mapping metadata (no reasoning text/prompts/credentials).
- [x] Adapter emission: OpenAI-compatible adapters emit the provider-native `reasoning` parameter from the translation result (binary `enabled`, discrete `effort`, budget `max_tokens`); the OpenRouter adapter no longer collapses `enabled`/`adaptive` into one boolean.
- [x] #68 gate wiring: explicit non-`OFF`/non-`AUTO` intent plus tool use demands `reasoningWithTools` evidence (`ReasoningRequirement` rename of the #68 eligibility type; taxonomy extended with `reasoning-translation-unsupported`/`reasoning-budget-policy-missing`).
- [x] Docs/RTM/AT: protocol compatibility canonical reasoning contract, ARCHITECTURE reasoning intelligence layer section, AT-048–AT-051, RTM Phase 70 evidence rows, TASKLIST milestone entry. Evidence: `tests/unit/reasoning-translate.test.ts`, decoder/contract/lifecycle/integration suites; `pnpm verify` green (see PR).

## Completed milestone: Phase 66 `rly config` control plane (#66)

- [x] `rly config` is the primary user-facing control plane after `rly init`: durable `~/.rly` configuration resolution from the installation record (no CWD `gateway.config.toml` on the normal installed path; explicit `--config` and the CWD file stay dev/operator fallbacks), resident-runtime ensure/recover (reuse attested launcher-owned or resident instances, start the registered service when down with a bounded readiness wait, session-scoped foreground fallback, occupied-foreign/attested-incompatible fail-closed), secret-free `status` summary, and a local loopback UI bootstrap through the existing single-use fragment session (`--headless` prints the URL without opening a browser; closing the UI never stops the resident runtime).
- [x] Focused shortcuts `rly config providers|accounts|pools|profiles` create/list and credential login/import/refresh/revoke flows through the same management endpoints, DTOs, and policy revision as `rly admin` (shared `src/cli/management-client.ts`); stale versioned mutations surface `stale-version` explicitly; no new configuration database.
- [x] Docs/RTM/AT: FR-019 / SR-F-023 added; AT-048–AT-052 added; README/CONTRIBUTING onboarding recipe is `rly init` once + `rly config` thereafter; ARCHITECTURE, ROADMAP, SPEC §6.6, RTM, TASKLIST updated. Evidence: `tests/unit/cli-config.test.ts`, `tests/lifecycle/config-recovery.test.ts`, existing admin/management/privacy suites; `pnpm verify` green.

## Completed milestone: Phase 74 RLY Claude configuration overlay (#74)

- [x] Replaced the throwaway `CLAUDE_CONFIG_DIR` temp directory with a durable RLY-owned Claude configuration namespace under the RLY home (`<control-plane>/claude`, `~/.rly/claude` by default): `src/runtime/claude-overlay.ts::prepareClaudeOverlay` composes native `~/.claude` (or parent `CLAUDE_CONFIG_DIR`) as read-only input through a typed allowlist — `settings.json` one-way merge (gateway-conflict `env` keys stripped, unrelated settings and native `model` kept, RLY-only `claude-rly-*` projection model preserved as RLY-owned state), user `agents/*.md`, `commands/*.md`, and `skills/**` one-way refresh copies, and `plugins/config.json` enablement declaration only (credential-bearing keys and plugin cache/repos never copied). `~/.claude.json` and project-local `.claude` are never touched.
- [x] `launchClaude(configDirectory)` uses the durable overlay and never deletes it; the interactive launch contract (`runHarnessCommand` in `src/cli/main.ts`) always prepares and passes the overlay (fail on overlay error, no throwaway sandbox fallback); Codex keeps its throwaway `CODEX_HOME` isolation.
- [x] Model persistence isolation: `/model` writes land only in the overlay; a plain `claude` launch never inherits RLY gateway env/auth or `claude-rly-*` projection ids; no post-exit “save old global model, rewrite it back” logic. RLY session/history state under the overlay survives RLY launches.
- [x] Refresh/precedence and concurrency: deterministic one-way refresh (missing or native-newer), unchanged native input not rewritten (sibling `/model` writes survive), native deletions not propagated, malformed native JSON skipped; all RLY writes atomic (`0700` dirs, `0600` files) so concurrent RLY launches converge without locks.
- [x] `rly status` reports a secret-free overlay summary (directory/source/allowlist version/composition timestamp).
- [x] Docs/RTM/AT: FR-020 / SR-F-024 added; AT-065–AT-072 added; SPEC §4.1/§6.7/§8, ARCHITECTURE overlay section + security boundary, protocol-compatibility overlay + layout pinning, project-decisions overlay decision with the retained no-global-Claude-config-mutation rule, RTM Phase 74 evidence rows, TASKLIST milestone entry. Evidence: `tests/lifecycle/claude-overlay.test.ts`, `tests/lifecycle/child-launcher.test.ts`, `tests/lifecycle/global-config-isolation.test.ts`, `tests/unit/cli-main.test.ts`, `tests/unit/cli-diagnostics.test.ts`, gated `tests/e2e/claude-code/overlay.e2e.test.ts` (`RLY_CLAUDE_E2E=1`, skipped ≠ pass); `pnpm verify` green.

## Completed milestone: Phase 71 Claude Code subagent model resolution (#71)

- [x] Claude Code agent attribution ingress: `X-Claude-Code-Session-Id`/`X-Claude-Code-Agent-Id`/`X-Claude-Code-Parent-Agent-Id` parse into a typed `AgentContext` on the canonical request at the Anthropic decoder (`src/core/agent-context.ts`) — no prompt/body inspection, case-insensitive, partial attribution allowed; agent ids are runtime data, never authorization.
- [x] Session-scoped execution-context registry (`src/profiles/agent-contexts.ts`): in-memory, lease-bound; records each agent's resolved provider/frozen physical model/model family/effective tier/revision after success; valid only while the owning lease is active; removed on lease revocation/expiry and runtime restart; never stores credentials/account identity.
- [x] Parent-context resolution in `resolveProfileRoute`: subagent tier requests inherit the parent agent's frozen model/family (exact parent match → session main context → unambiguous profile-default fallback); the resolved parent context feeds #69 tier resolution, then #68 exact selection, #70 reasoning translation, and the existing account pool for the frozen target; parent/main model, profile mapping, and global settings are never mutated; concurrent subagents resolve independently; undeterminable families fail closed (`family-unknown` → `tier-unavailable` with an actionable `cause`).
- [x] Explicit subagent `effort` is preserved through the canonical reasoning request and translated by #70 (traceable); a tool-using subagent with explicit reasoning demands `reasoningWithTools` evidence and fails closed with the underlying #68 cause; no global `CLAUDE_CODE_SUBAGENT_MODEL` override and no source-agent-file rewrite.
- [x] Trace/privacy: `ProfileDecisionTrace.agentLinkage` carries only hashed session/agent/parent pseudonyms plus the parent model/family used for tier resolution; existing suites stay green.
- [x] Docs/RTM/AT: FR-021 / SR-F-025 added; AT-084–AT-090 added; SPEC §6.1, ARCHITECTURE subagent execution-context section, protocol-compatibility agent attribution section, project-decisions subagent decision, RTM Phase 71 evidence rows, TASKLIST milestone entry. Evidence: `tests/unit/agent-context.test.ts`, `tests/contract/anthropic/messages.test.ts`, `tests/lifecycle/subagent-profile-route.test.ts`, gated `tests/e2e/claude-code/subagent-model.e2e.test.ts` (`RLY_CLAUDE_E2E=1`, skipped ≠ pass; validated against local Claude Code 2.1.231); `pnpm verify` green.

## Completed milestone: Phase 72 gateway model discovery and projection (#72)

- [x] Authenticated `GET /v1/models` on the gateway listener matching the supported Claude Code discovery wire contract (`{data:[{type,id,display_name,created_at}], has_more, first_id, last_id}` + `limit`/`before_id`/`after_id` pagination), served behind the same launch/gateway inference credentials (session token ⇒ pinned universe; instance bearer ⇒ policy-derived universe); no second server.
- [x] Deterministic projection engine (`src/routing/model-projection/`): Claude-compatible `claude-rly-<provider>-<hash>` ids (canary: all ids begin with `claude`/`anthropic`), explicit reverse mapping to one exact access-provider/model target + pinned pool (routing never parses ids), presentation-only display labels (same upstream model through two providers ⇒ distinct targets), VERIFIED-only by default with `EXPERIMENTAL` behind the explicit `gateway.modelDiscovery.experimentalModels` opt-in and BROKEN/unreviewed/proposed never exposed.
- [x] Session-pinned model universe compiled at launch-session issue (policy revision/hash, registry revision, provider→pool bindings = profile pool + single-eligible-default-pool providers, experimental policy); policy/registry drift never silently remaps an issued projection id; removed/broken/ineligible targets fail closed (`model-unavailable`/`capability-rejected`) with no silent substitution.
- [x] Exact projected selection routes through the existing two-stage boundary (#68 exact selection + #70 reasoning translation, then the pinned pool's account selector) and carries allowlisted projection id/display metadata on the route trace; secret-free discovery/traces.
- [x] Child-only `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` in the Claude child env (parent/global env unchanged); overlay strips the key from native settings env (allowlist v2) so RLY sessions cannot be silently disabled and plain `claude` launches never inherit RLY discovery env/auth/projection ids.
- [x] Docs/RTM/AT: FR-021 / SR-F-025 added; AT-073–AT-083 added; SPEC §4.1/§6.1, ARCHITECTURE model projection section, protocol-compatibility discovery contract + exact-vs-tier aliases, project-decisions projection decision, BACKLOG BL-042 wording, RTM Phase 72 evidence rows, TASKLIST milestone entry. Evidence: `tests/unit/model-projection.test.ts`, `tests/lifecycle/gateway-models-route.test.ts`, `tests/lifecycle/child-launcher.test.ts`, `tests/lifecycle/claude-overlay.test.ts`, `tests/unit/profiles.test.ts`, `tests/unit/cli-diagnostics.test.ts`; `pnpm verify` green.

## Completed milestone: Phase 73 safe zero-downtime runtime update lifecycle (#73)

- [x] Durable secret-free update states (`src/runtime/update/`): `idle`/`installing`/`pending-activation`/`activating`/`active`/`rollback-required`/`failed` under `<control-plane>/update-state.json` (`0600` atomic files), CAS transitions, and an ownership-aware update lock (`update.lock`, pid + start-identity stale reclaim like the startup lock) so concurrent `rly update` invocations serialize.
- [x] Extended identity/version handshake: `/identity` reports the serving runtime version, durable state/schema version, update snapshot (pending/previous), active launch-session count, and drain flag; authenticated `POST /drain` refuses new launch-session issuance with `update-pending`; `GatewayServerOptions.runtimeVersion/stateVersion/updateState` wired by `owned-gateway.ts`; reused resident handles carry `runtimeVersion` for the launch gate.
- [x] `rly update` lifecycle coordinator (`src/runtime/update/lifecycle.ts`): install → pending → drain (launch-session count, `--force` = explicit destructive path) → begin drain → re-register definition + service-manager `restart()` (#33/#34, only attested resident instances) → verify (attested identity + authenticated `/readyz` + state/schema compatibility + serving version matches candidate) → active; one bounded rollback to the preserved previous known-good version on failure; both-fail ⇒ `failed` with a deterministic doctor action; foreign port owners fail closed, never signaled; no loops.
- [x] Deterministic compatibility/launch policy (`src/runtime/update/policy.ts`): same-major CLI/runtime pairs may keep launching on the old runtime while pending; incompatible pairs refuse only new launches with an actionable `update-pending`/`runtime-version-mismatch` message; forward-only/unrollbackable candidate migrations block activation before any destructive state change.
- [x] Distribution-agnostic `CandidateInstaller` contract + local candidate swap installer (`src/runtime/update/installer.ts`): `current`/`previous` symlink swap under `<control-plane>/runtime/`, manifest-verified candidates, `restorePrevious()` rollback reference; #35 owns signed distribution (BACKLOG, documented).
- [x] CLI surface: `rly update [--candidate <dir>] [--version <v>] [--force] [--wait-timeout <ms>] [--config]` (installed/pending/activated/rolled-back/failed output), launch-policy gate on new launches, and allowlisted update metadata in `rly status`/`rly doctor` (state, current/pending/previous version, active sessions, drain, CLI↔runtime compatibility).
- [x] Crash/reboot recovery: interrupted install → `failed` with retry guidance; pending activation resumes once the candidate verifies; interrupted activation rolls back using the preserved previous-version reference; stale update locks reclaimed.
- [x] Docs/RTM/AT: FR-023 / SR-F-027 added; AT-103–AT-118 added (checked against merged dev max AT-102); SPEC §6.7, ARCHITECTURE update-lifecycle section, project-decisions safe-update decision, BACKLOG #35 split, ROADMAP Milestone 9, RTM Phase 73 evidence rows, TASKLIST entry. Evidence: `tests/lifecycle/runtime-update.test.ts`, `tests/unit/update-policy.test.ts`, `tests/unit/update-state-store.test.ts`, `tests/unit/update-installer.test.ts`, `tests/unit/cli-update.test.ts`, `tests/unit/cli-diagnostics.test.ts`; `pnpm verify` green (see PR).

## Completed milestone: Phase 24 runtime compatibility canary (#24 / BL-043)

- [x] Exact installed client version detection separate from binary `found`: `src/targets/versions.ts::probeClientVersion` parses the semantic/version token from the client's own `--version` output with a bounded timeout; silent/broken/missing binaries report `unknown`; versions are never inferred from timestamps, package directories, or paths; `src/canary/installed.ts::detectInstalledClients` composes found + exact version; `rly doctor` reports installed versions, the tested baseline (`claude-code-2.1.229` fixture baseline; observed 2.1.231 and Codex `0.147.0-alpha.6.5` recorded separately, never auto-supported), and the live-gate env.
- [x] Pinned baseline wire-contract fixtures (`src/canary/client-fixtures.ts` + `tests/fixtures/upstream/claude-code/{client-contract-2.1.229,model-discovery-shape,fable-subagent-shape,effort-signal-shape,streaming-framing}.json` and `tests/fixtures/upstream/codex/client-contract-observed.json`): attribution headers, `GET /v1/models` request/auth/response selection incl. the `claude`/`anthropic` id-prefix rule and startup cache, `fable`/`haiku`/`sonnet`/`opus` aliases, subagent/session `effort`, streaming framing, `--no-session-persistence`.
- [x] Deterministic fake gate matrix (`src/canary/matrix.ts`): text, streaming, cancellation, single/multi/parallel tool loops, reasoning, reasoning+tools, model discovery, session attribution, subagent routing, parallel subagents, effort signal, long-running session; capability-dependent gates stay `not-run` without reviewed evidence; deliberately changed fixtures fail the exact gate with a typed reason (`missing-agent-header`, `gateway-model-filter-changed`, `tool-result-invalid`, `reasoning-effort-clamped`, `effort-signal-lost`).
- [x] Classification (`src/canary/classify.ts`): `VERIFIED` = all required gates + live evidence where the provider class requires it (all shipped adapters live-required); fake-only = `EXPERIMENTAL`; failed required contract = `BROKEN`; unrun required gates = `unknown` (never reported as passed); evidence keyed by exact client kind/version + provider + adapter + physical model with no cross-provider reuse; proposals (`src/canary/proposals.ts`) never mutate the trusted registry. (Updated by #122: `livePassed`/`liveEvidence` removed; `VERIFIED` is unreachable from observations and promotion is #124.)
- [x] `rly canary run|status` (`src/cli/canary.ts`) + secret-free artifacts under `<control-plane>/canary/` (`src/canary/artifact.ts`, `0700` dir / `0600` files, fail-closed malformed reads); #72 projection gate consumes canary-derived state (VERIFIED default, EXPERIMENTAL opt-in, BROKEN never — `tests/unit/canary-projection.test.ts`); live evidence opt-in env `RLY_LIVE_CANARY` documented, skipped ≠ pass.
- [x] Docs aligned: FR-022 / SR-F-026 added; AT-091–AT-102 added; protocol-compatibility runtime canary section; project-decisions observed-vs-tested baseline + canary decision; SPEC §6.9 + canary acceptance criterion; ARCHITECTURE canary section; BACKLOG BL-043 landed; ROADMAP Milestone 10; RTM Phase 24 evidence rows; TASKLIST entry. Evidence: `tests/unit/canary-matrix.test.ts`, `tests/unit/canary-evidence.test.ts`, `tests/unit/canary-projection.test.ts`, `tests/unit/cli-canary.test.ts`, `tests/unit/targets.test.ts`, `tests/unit/cli-diagnostics.test.ts`, `tests/privacy/canary.test.ts`; `pnpm verify` green.

## Completed milestone: Phase 125 typed model intent and selector namespaces (#125)

- [x] Typed model intent (`src/routing/model-intent/`): `EXACT_PROJECTION`, `RLY_LOGICAL_TIER`, `CLIENT_NATIVE_ALIAS`, `EXACT_CLIENT_MODEL`, `INHERIT`, `DEFAULT` with exact source-selector + provenance metadata preserved for diagnostics.
- [x] RLY logical selector namespace: explicit `rly-tier:haiku|sonnet|opus|fable`; unknown `rly-tier:` values fail closed (`unknown-namespace`) and are never reinterpreted; bare client-native aliases are never RLY policy selectors by string equality (core invariant `fable != rly-tier:fable`).
- [x] Deterministic classification precedence (explicit `rly-tier:` → projection → client alias → inherit → default → exact model) with typed failure taxonomy (`unknown-namespace`/`unsupported-client-alias`/`invalid-projection`/`conflicting-selector-sources`) mapped onto the existing profile error contract.
- [x] Routing integration: `resolveProfileRoute` classifies the selector first; the #69 provider/family tier resolver runs only for typed tier intent (or an alias mapped through the explicit traceable client-alias contract); the classifier-computed role/model id is authoritative for every intent kind; exact projection dispatch (#72) is unchanged; `ProfileDecisionTrace.intent` carries secret-free selector kind/source/resolved target.
- [x] Migration/compatibility: bare-tier selectors and `profile.modelRoles` tier keys keep their meaning; persisted exact model ids are never reinterpreted as tiers (#68 exact path preserved); #68/#69 aggregator affinity and account-selection-after-model-selection tests stay green.
- [x] Docs/RTM/AT: FR-024 / SR-F-028 added; AT-119–AT-128 added; ARCHITECTURE model-intent section, protocol-compatibility selector-namespace contract, project-decisions namespace decision, RTM Phase 125 evidence rows, TASKLIST entry. Evidence: `tests/unit/model-intent.test.ts`, `tests/lifecycle/model-intent-route.test.ts`, `tests/unit/tier-resolver.test.ts`, `tests/lifecycle/cline-profile-route.test.ts`, `tests/lifecycle/profile-pool-route.test.ts`, `tests/privacy/*`; `pnpm verify` green (see PR).

## Completed milestone: Phase 119 native protocol rails, fidelity envelope, opaque continuation artifacts (#119)

- [x] Versioned fidelity/continuation envelope (`src/core/fidelity.ts`): source protocol/revision, typed opaque artifacts (kind/association/value), translation provenance (`preserved-native`/`translated`/`ignored`/`unsupported`), required-artifact kinds; `mergeFidelity`/`artifactValue`/`unsupportedRequiredArtifacts`/`describeFidelity`; Zod persistence schema.
- [x] Anthropic fidelity: decoder preserves `thinking.signature` into the envelope (required when present, association `message:block`) with the thinking text as the `translated` semantic projection; canonical `signature-delta` event; encoder emits `signature_delta` in valid order (after `thinking_delta`, before `content_block_stop`) and fails closed (`invalid_event_order`) on non-thinking/out-of-order deltas; aggregator attaches the signature to the aggregate thinking block; byte-level golden SSE fixture (`anthropic-signature-delta-sse.json`).
- [x] OpenAI Responses fidelity: decoder preserves reasoning item identity (semantic) + opaque `encrypted_content` (envelope, required when present); `ResponseContinuationStore` persists the fidelity envelope and merges prior artifacts into a subsequent `previous_response_id` request; re-encode attaches each reasoning item's exact encrypted content — never reconstructed from summary text.
- [x] Fail-closed policy: `OpenAiChatAdapter.invoke` raises `unsupported-fidelity` before any upstream call when a required artifact cannot be represented on the Chat Completions transport (OpenRouter/DeepSeek); no fabrication/reconstruction.
- [x] Unknown additive fields on both protocols recorded as `ignored` provenance notes; redaction treats `signature`/`value` keys as sensitive; `describeFidelity()` is the only diagnostic surface (provenance metadata only).
- [x] Fixtures/tests: `anthropic-thinking-signature`, `anthropic-signature-delta-sse`, `anthropic-unknown-additive`, `openai-reasoning-encrypted`, `openai-reasoning-tool-interleave`, `openai-unknown-additive`; contract suite `tests/contract/protocol-fidelity.test.ts` (13) and privacy suite `tests/privacy/protocol-fidelity.test.ts` (7).
- [x] Docs/RTM/AT: FR-025 / SR-F-029 added; AT-129–AT-138 added (checked against merged dev max FR-024 / SR-F-028 / AT-128 from #125); protocol-compatibility native-rails section; ARCHITECTURE fidelity-envelope authority section; project-decisions decision; RTM Phase 119 evidence rows; TASKLIST entry. Evidence: `pnpm lint`, `pnpm typecheck`, `pnpm test` (595 passed / 22 skipped), `pnpm test:privacy` (24 passed; privacy scan 377 files), `pnpm build`, `git diff --check` all green.

## Completed milestone: Phase 92 immutable deployments and atomic activation refs (#92)

- [x] Immutable artifact identity: `computeArtifactId` is a SHA-256 over the exact candidate tree bytes (sorted relative paths + file contents; symlinks/special files fail closed); semantic version is metadata only, never the directory key; byte-distinct candidates with the same semantic version never share/alias one deployment directory.
- [x] Immutable runtime store: deployments live content-addressed under `<control-plane>/runtime/versions/<artifactId>`; a successfully installed immutable deployment is never recursively replaced (identical reinstall is an idempotent no-write); a completed layout (private 0700 dir, matching `.rly-deployment.json` identity, valid manifest/entrypoint) is validated before any reference exposes it; stale `.staging-*` directories are cleaned.
- [x] INSTALL != ACTIVATE: `installCandidate` updates only `refs/staged`; `activateStaged()` is the only primitive switching `refs/active` (preserving the displaced deployment as `refs/previous`), invoked by the lifecycle only at the activation transition immediately before the controlled restart; a blocked forward-only migration no longer needs an install-time restore because staging never touched `active`.
- [x] Atomic reference replacement: temp-reference create + rename + parent-directory fsync, never `rm + symlink`; stale `.ref.tmp` temps cleaned on the next replace; readers observe old-or-new valid refs, never a gap.
- [x] Legacy migration: `runtime/current`/`previous` + `versions/<semver>` layouts migrate in place (bytes renamed to artifact ids + store-owned metadata backfilled, never deleted) with a durable `migrating`/`committed` marker so crashes resume idempotently; legacy refs resolve to artifact ids before any rename (malformed state fails closed with `run rly doctor`); duplicate legacy dirs removed only after the committed marker; fresh installs record an empty committed marker so legacy scanning never re-runs.
- [x] Secret-free ownership: deployment metadata/refs carry version/build/digest/path identifiers only (never credentials, auth headers, account identity, prompts, responses, reasoning text); 0700 dirs / 0600 files, current-user symlinks only.
- [x] Stable service entrypoint: `rly update` registers the service definition against `runtime/refs/active/dist/cli/main.js` so the manager always points at the currently serving immutable deployment.
- [x] Docs/RTM/AT: FR-023 / SR-F-027 extended; AT-139–AT-149 added (checked against merged dev max AT-138 from #119); ARCHITECTURE immutable-store section, project-decisions #92 decision, RTM Phase 92 evidence rows, TASKLIST entry. Evidence: `tests/unit/update-installer.test.ts`, `tests/lifecycle/runtime-update.test.ts`, `tests/unit/update-state-store.test.ts`, `tests/service-manager/*`, `tests/privacy/*`; lint/typecheck/`pnpm test`/`pnpm test:lifecycle`/`pnpm test:privacy`/`pnpm build` green (see PR).

## Completed milestone: Phase 126 profile-scoped Claude views and env/settings ownership (#126)

- [x] Profile-scoped view identity (`src/runtime/claude-overlay.ts`): deterministic `deriveClaudeViewId(profileId)` (immutable profile id, collision-safe, reserved `default` for profile-less launches); views live at `<control-plane>/claude/views/<view-id>`; `LaunchSession.viewId` (`src/profiles/sessions.ts`) and CLI wiring (`src/cli/main.ts`) derive the view per profile launch; two profiles can never share RLY-only model/default/cache/history state; plain non-RLY Claude unaffected.
- [x] Typed env/settings ownership: `SettingsOwnership` categories (RLY-owned / conflicting / safe pass-through / unsupported / user override), `classifySettingsKey`/`classifySettingsEnvKey`/`settingsOwnershipSummary`, deterministic precedence (child-only RLY gateway contract env > RLY-owned persisted projection model > explicit RLY/profile launch-policy settings > native input > client persistence > defaults); unsupported credential-bearing shapes (`oauthAccounts`) are never composed; explicit launch-policy `model`/`env` tier added to `launchPolicySchema` (`src/profiles/schema.ts`) and `child-launcher.ts` (`environmentOverrides` below the gateway contract).
- [x] Ownership manifest (`.rly-manifest.json`, metadata + sha256 hashes only): native-imported / RLY-generated / view-owned categories; gateway-contract and unsupported key names excluded from settings import metadata.
- [x] Deletion/rename reconciliation: imported view files removed when the native source disappeared and the view copy matches the imported hash; divergent copies reclassified view-owned and kept; native-source-exists guard prevents deleting live imports; no additive-only ghost files; settings recomposed as RLY-generated when native settings are removed (RLY-owned model survives).
- [x] Concurrency: atomic temp+rename writes (`0600`/`0700`), bounded per-view reconcile lock (best-effort when busy); never rewrites or “restores” native settings; migration of the legacy shared overlay into `views/default` via crash-safe two-phase sibling rename (never re-migrating the live view container, never touching `~/.claude`).
- [x] Diagnostics/privacy: `rly status`/`rly doctor` expose `claudeViews` (view id/path, allowlist version, ownership counts, reconciled deletions/reclassifications, conflicting key categories, last refresh) — never settings content, prompts, transcripts, skills/agents text, credentials, auth tokens, or account identity.
- [x] Tests: lifecycle overlay suite grown to 25 tests (profile isolation, manifest, deletion/reconcile, divergent reclassification, explicit-tier precedence, native-settings-removal recompose, migration, concurrent prepares across views, credential-free view/manifest, per-view statuses); unit + lifecycle + e2e overlay + diagnostics tests updated for the view layout.
- [x] Docs/RTM/AT: FR-026 / SR-F-030 added; AT-150–AT-159 added (checked against merged dev max FR-025 / SR-F-029 / AT-149 from #92/#119); ARCHITECTURE profile-scoped-views section; protocol-compatibility view-layout table; project-decisions #74→#126 decision; RTM Phase 126 evidence rows; TASKLIST entry; AT-149 restored for the #92 docs ownership row (was transiently mislabeled AT-138 during the 126 docs edit). Evidence: `pnpm lint`, `pnpm typecheck`, `pnpm test` (614 passed / 22 skipped), `pnpm test:privacy` (24 passed; privacy scan 377 files), `pnpm build`, `git diff --check`, and gated real-Claude black-box sentinel E2E `RLY_CLAUDE_E2E=1 pnpm vitest run tests/e2e/claude-code/overlay.e2e.test.ts` (1 passed, claude 2.1.231) all green (see PR).

## Completed milestone: Phase 93 transactional activation (#93)

- [x] Correct update ownership lock: `acquireLock()` records the real OS process-start identity from the process-attestation subsystem (never acquisition wall-clock time; `identityVerified` flag); unverifiable owners are conservatively held; only locks whose owner identity is proven stale/dead are reclaimed; `lockStatus()` exposes held/ownerPid/stale for status/doctor.
- [x] Durable activation transaction journal: secret-free `transaction` record on `update-state.json` with phases STAGED → DRAINING → SWITCHING → PROBATION → COMMITTING → COMMITTED (or ROLLING_BACK → COMMITTED | RECOVERY_REQUIRED), each durably written before the action it fences, carrying candidate/previous artifact ids + bounded `rollbackAttempts`; crash recovery is phase-driven and NEVER guesses a candidate committed (post-switch phases roll back; COMMITTED promotes; interrupted/duplicate rollback is terminal `recovery-required`).
- [x] Fence-first drain: the new-launch fence (authenticated `/drain`) is established BEFORE the serving ref switch; existing sessions complete on the old runtime and in-flight streams/tool loops are never replayed/moved; `--force` remains a separate destructive path that skips only the drain wait.
- [x] Migration compatibility classes: `none`/`backward-compatible-expand`/`transactional-replace` pass preflight; `forward-only` blocks activation before destructive state change; legacy `migrationForwardOnly` maps to a class (true ⇒ forward-only, false ⇒ backward-compatible-expand); manifests and deployment metadata carry `migrationClass`.
- [x] Probation + commit boundary: candidate accepted only after exact runtime identity + management/data protocol + authenticated readiness/state-open + state/schema verification; only then COMMITTING → COMMITTED (one atomic commit write).
- [x] Bounded rollback + terminal recovery: exactly ONE rollback attempt re-establishes `active`/`previous` from durable journal evidence (previous written before active; known-good never lost — `setActiveReferences` recovery primitive), restarts at most once, verifies the restored runtime; failure terminates in explicit `recovery-required` with a `run rly doctor` path and no restart loop.
- [x] Crash/reboot + service-manager race coverage: real-ref crash windows before/after fence, ref switch, restart, migration, probation, commit, rollback preserve `previous`/`staged`/`active` integrity; recovery is idempotent; existing foreign-listener, credential, no-unsafe-retry, and privacy invariants stay green.
- [x] Diagnostics/privacy: `/identity`, `rly update`, `status`, `doctor` expose allowlisted transaction phase, lock-owner status, drain state, and last activation/rollback outcome (identifiers only — no secrets, prompts, responses, or account identity).
- [x] Docs/RTM/AT: FR-027 / SR-F-031 added; AT-160–AT-168 added (checked against merged dev max FR-026 / SR-F-030 / AT-159 from #126); ARCHITECTURE transactional-activation section, project-decisions #93 decision, SPEC §6.7, RTM Phase 93 evidence rows, TASKLIST entry. Evidence: `tests/lifecycle/update-transaction.test.ts`, `tests/lifecycle/runtime-update.test.ts`, `tests/unit/update-state-store.test.ts`, `tests/unit/update-installer.test.ts`, `tests/unit/update-policy.test.ts`, `tests/unit/cli-update.test.ts`, `tests/unit/cli-diagnostics.test.ts`, `tests/privacy/*`; `pnpm verify` green (see PR).
## Completed milestone: Phase 122 Compatibility Claim and Evidence v2 (#122)

- [x] Versioned, feature-scoped Compatibility Claim + Evidence model (`src/canary/claim.ts`): stable claim key (`claimKeyFor`/`claimKeyHash`) over the exact execution path — client kind, exact client version/baseline, source protocol/revision (#119 vocabulary), adapter/integration surface, access provider, auth mode, endpoint contract, exact physical model, feature/capability claim; model family is metadata only, never part of the key; same model through two providers and two features on one path produce distinct keys/histories (no cross-provider/model/feature reuse).
- [x] Feature-scoped claims (text, streaming, cancellation, tools incl. parallel/multi-tool continuation, reasoning, reasoning+tools, model discovery, session/subagent attribution, config-overlay, and other relied-on features) with independent results; capability-gated features stay `not-run`/`missing`, never passed.
- [x] Evidence Artifact v2 (claim key, layer/kind, fixture revision, runner version, timestamp, result `passed`/`failed`/`not-run`, typed failure reason, environment metadata, safe refs) — secret-free, never credentials/auth headers/account identity/prompts/responses/reasoning text.
- [x] Explicit evidence layers A (deterministic fake-matrix conformance — the current canary matrix is reclassified as Layer A), B (installed-client black-box), C (live access-path); required layers declared per adapter (`requiredLayersForAdapter`, unknown adapters fail closed A/B/C); layer presence/result explicit per claim; Layer B/C runners are #123 (not built here).
- [x] `livePassed`/`liveEvidence` removed from the authoritative classification path: classification can never emit `VERIFIED` from an observation (full deterministic pass = `EXPERIMENTAL` + `production-claim-not-established`); `RLY_LIVE_CANARY`/`liveRunnerEnabled` only enables a runner hook and can never create evidence.
- [x] Schema/version + legacy migration: claim `schemaVersion` 1 / evidence `evidenceSchemaVersion` 2; legacy v1 canary artifacts flagged `legacy-v1-artifact-untrusted-for-v2-claims` (readable, never satisfying a v2 claim); registry revision bumped 4→5 with optional `CompatibilityEvidence.claimRef` (pre-v5 rows untrusted for v2 claim authority).
- [x] Append/audit-friendly persistence (`ClaimEvidenceStore`, `<control-plane>/claims/`): atomic writes, appended records never silently rewritten, exact-duplicate dedupe, fail-closed malformed reads, deterministic lookup by exact claim identity + feature; `rly canary run|status` persists and reports claim/evidence schema + legacy policy; doctor exposes `evidenceSchemaVersion` + legacy policy.
- [x] Docs/RTM/AT: FR-028 / SR-F-032 added; AT-169–AT-179 added (checked against merged dev max FR-026 / SR-F-030 / AT-159); SPEC §6.10 + canary acceptance; ARCHITECTURE claims/evidence section; protocol-compatibility claims section; project-decisions decision; RTM Phase 122 evidence rows; TASKLIST entry. Evidence: `tests/unit/canary-claim.test.ts`, `tests/unit/canary-evidence.test.ts`, `tests/unit/canary-matrix.test.ts`, `tests/unit/canary-projection.test.ts`, `tests/unit/cli-canary.test.ts`, `tests/unit/model-registry.test.ts`, `tests/unit/cli-diagnostics.test.ts`, `tests/privacy/canary.test.ts`; `pnpm lint`, `pnpm typecheck`, `pnpm test` (631 passed / 22 skipped), `pnpm test:privacy` (27 passed; privacy scan 379 files), `pnpm build`, `git diff --check` all green (see PR).

## Updating this file

- Check an item only when evidence exists.
- Keep task implementation detail in phase files.
- Move uncommitted ideas to `BACKLOG.md`, not this list.
- When scope changes, update `SPEC.md` first if product behavior changes.

## Unresolved questions

- CLIProxy Plus is independently MIT-licensed and pinned as a release tarball, but `+dirty` blocks source copy. First UI scope is admin plus diagnostics. Codex OAuth and ClinePass through Claude Code are in this milestone; Claude subscription OAuth stays in BACKLOG.
