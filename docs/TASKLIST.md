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
- [x] Secret-free local UI and provider expansion. Evidence: `pnpm verify` including `pnpm test:browser`; create-time catalog reject; Cline endpoint policy; Gemini/Antigravity live smokes opt-in skipped. Claude OAuth and Cline Claude Code E2E stay in BACKLOG.
- [x] OpenAI Responses and Codex CLI E2E. Evidence: `tests/contract/openai-responses/responses.test.ts`, `tests/e2e/codex/fake-upstream.e2e.test.ts`, `run codex` isolation in `tests/lifecycle/global-config-isolation.test.ts`.
- [x] Release hardening, packaging, provenance, migration, recovery, and daily workflow gates. Evidence: `pnpm test:release`, `tests/storage/retention.test.ts`, existing migration/crash suites plus license/package/clean-install scripts.
- [x] Release-lane automation and post-Stable alignment. Evidence: `tests/unit/release-automation.test.ts`, `.github/workflows/release-beta.yml`, `.github/workflows/release-stable.yml`; Slack delivery requires the repository `SLACK_WEBHOOK_URL` secret and the documented GitHub Actions ruleset bypass.

## Updating this file

- Check an item only when evidence exists.
- Keep task implementation detail in phase files.
- Move uncommitted ideas to `BACKLOG.md`, not this list.
- When scope changes, update `SPEC.md` first if product behavior changes.

## Unresolved questions

- CLIProxy Plus is independently MIT-licensed and pinned as a release tarball, but `+dirty` blocks source copy. First UI scope is admin plus diagnostics. Next integration is Codex OAuth and ClinePass through Claude Code; Claude subscription OAuth is parked in BACKLOG.
