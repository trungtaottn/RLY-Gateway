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

## Completed milestone: Phase 67 model foundation — provider model intelligence registry

- [x] Canonical model evidence distinguishes access provider, exact upstream model id, and upstream/model family where known; one aggregator provider exposes many families without parallel registries (#67).
- [x] Same upstream model id through two access providers stays two separate entries; exact lookup fails closed for missing/cross-provider evidence.
- [x] Existing `ProviderCapabilities` evidence preserved and extended with typed reasoning/limit metadata; compatibility state (`VERIFIED`/`EXPERIMENTAL`/`BROKEN`) is typed and separate from raw capability support with baseline/evidence/check-date provenance.
- [x] Deterministic query helpers (provider-scoped, family-scoped, capability predicate, compatibility filtering) with no account selection or credential access (#68/#69).
- [x] Discovery→proposal boundary: `proposeRegistryChanges()` returns proposed candidates without mutating the trusted registry; #23 propose-only behavior enforced by tests.
- [x] Registry revision bumped 3→4 with migration for static legacy documents; `ProviderRecord.capabilityEvidence` typed (was `unknown`) and schema-validated at the management boundary and row parse.
- [x] Docs/RTM/AT identify the registry as the source of truth for #68-#72 and explain evidence ownership (reviewed vs discovered vs #24 canary). Evidence: `pnpm verify` — see PR.

## Updating this file

- Check an item only when evidence exists.
- Keep task implementation detail in phase files.
- Move uncommitted ideas to `BACKLOG.md`, not this list.
- When scope changes, update `SPEC.md` first if product behavior changes.

## Unresolved questions

- CLIProxy Plus is independently MIT-licensed and pinned as a release tarball, but `+dirty` blocks source copy. First UI scope is admin plus diagnostics. Codex OAuth and ClinePass through Claude Code are in this milestone; Claude subscription OAuth stays in BACKLOG.
