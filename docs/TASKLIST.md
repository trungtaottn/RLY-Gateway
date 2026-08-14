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

## Updating this file

- Check an item only when evidence exists.
- Keep task implementation detail in phase files.
- Move uncommitted ideas to `BACKLOG.md`, not this list.
- When scope changes, update `SPEC.md` first if product behavior changes.

## Unresolved questions

- CLIProxy Plus is independently MIT-licensed and pinned as a release tarball, but `+dirty` blocks source copy. First UI scope is admin plus diagnostics. Codex OAuth and ClinePass through Claude Code are in this milestone; Claude subscription OAuth stays in BACKLOG.
