# Agent Gateway Tasklist

This file is the concise committed-work view. Detailed steps, risks, and acceptance evidence live in the [active implementation plan](../plans/260813-1239-claude-first-personal-gateway/plan.md).

## Completed milestones: Bootstrap through Claude direct-provider MVP

- [x] Create clean `agent-gateway` Git repository on `main`.
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

## Current milestone: Authority and source freeze

- [x] Accept self-owned control plane, OAuth credentials, explicit import, and account pools.
- [x] Supersede the bridge-only credential restriction.
- [x] Define request-time eligibility, selection, and immutable EffectiveRoute.
- [ ] Pin exact source artifacts, hashes, licenses, and module adaptation matrix.
- [ ] Prove CLIProxy Plus provenance separately from CCS.
- [ ] Create sanitized compatibility fixtures for copied behavior.

## Later committed V1 milestones

- [ ] Control-plane schema, migrations, authenticated management API, and CLI.
- [ ] Credential broker and project-owned Codex OAuth vertical slice.
- [ ] Deterministic pool engine and Claude Code integration.
- [ ] Profiles, launcher, status, doctor, and quota UX.
- [ ] Secret-free local UI and provider expansion.
- [ ] OpenAI Responses and Codex CLI E2E.
- [ ] Release hardening, packaging, provenance, migration, recovery, and daily workflow gates.

## Updating this file

- Check an item only when evidence exists.
- Keep task implementation detail in phase files.
- Move uncommitted ideas to `BACKLOG.md`, not this list.
- When scope changes, update `SPEC.md` first if product behavior changes.

## Unresolved questions

- Exact CLIProxy Plus source/license pin and first UI scope remain open in the active plan.
