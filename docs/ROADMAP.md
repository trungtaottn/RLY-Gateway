# RLY Gateway Roadmap

Roadmap describes release sequence. Detailed execution and evidence live in the active plan.

## Milestone 0 — Bootstrap baseline

Outcome: one coherent project authority and safety contract.

- Product SPEC, tasklist, backlog, architecture, tech stack, roadmap, ADRs, contribution workflow.
- Clean Git root with provenance research inside the project.
- Port/process/global-config preflight evidence.

Exit: bootstrap documents agree, Phase 01 review/test passes, no external state attributed without evidence.

## Milestone 1 — Foundation

Outcome: safe local gateway shell without a live provider.

- Strict TypeScript toolchain and CI-ready scripts.
- Config schema and secret references.
- Canonical contracts, capability registry, immutable routing.
- Redacted diagnostics.
- Deterministic foreground lifecycle, ownership attestation, leases, transient auth.

Exit: unit, lifecycle, privacy, lint, typecheck, and build gates pass.

## Milestone 2 — Anthropic protocol fidelity

Outcome: Claude protocol contract works against fake upstream.

- Messages streaming and non-streaming.
- Images, tools, thinking, usage, stop reasons, cancellation.
- Count-token quality contract.
- Golden byte/event-order fixtures and failure scenarios.

Exit: all Anthropic contract and fake-upstream integration gates pass.

## Milestone 3 — Claude Code MVP

Outcome: real Claude Code works through one direct live provider.

- OpenRouter first; DeepSeek second.
- Model-role mapping.
- Real Claude Code fake-upstream E2E.
- One opt-in live provider smoke.

Exit: text/tools/helper/cancellation/concurrency/no-global-mutation acceptance passes.

## Milestone 4 — Source and authority freeze

Outcome: the accepted control-plane product and reusable upstream sources are implementation-ready.

- Supersede the bridge-only credential decision and replace the active plan.
- Pin source revisions or tarball hashes, licenses, modules, and adaptation classifications.
- Establish credential, account, pool, management, migration, and audit contracts.

Exit: authority documents agree; every planned copied module has provenance and an owning boundary.

## Milestone 5 — Control plane and credential broker

Outcome: one project-owned Codex OAuth account can be safely administered and used through Claude Code.

- SQLite metadata and migrations for providers, accounts, profiles, pools, health, policy, and audit.
- Authenticated loopback management API and CLI.
- Project-owned credential store, explicit import/login/refresh, generation CAS, backup, and recovery.
- Manual account selection and pause.

Exit: secret/recovery/concurrency/management security gates and one Codex OAuth vertical slice pass.

## Milestone 6 — Deterministic pools and Claude integration

Outcome: Claude Code uses multiple eligible accounts through deterministic, observable routing.

- Eligibility, manual pin, `round-robin`, `fill-first`, quota/cooldown feedback, affinity, bounded pre-stream retry.
- Request-scoped EffectiveRoute with policy revision and credential generation.
- Claude Code fake E2E and opt-in live smoke through the account pool.
- CCS-style profiles, model roles, launcher, status, doctor, and quota UX.

Exit: race/crash/recovery/tool safety and no-global-mutation gates pass.

## Milestone 7 — UI and provider breadth

Outcome: local configuration UI and additional accepted providers use the same management and adapter contracts.

- Secret-free local UI.
- Google Gemini/Code Assist OAuth, Google Antigravity, Cline interoperability, Claude subscription, OpenCode Go, Alibaba, and managed bridges selected provider by provider.
- Every adapter declares ownership, terms, capabilities, import behavior, and live evidence.

Exit: every enabled provider passes its credential, protocol, pool, privacy, and live opt-in contract.

## Milestone 8 — Codex harness and release

Outcome: Codex CLI works through OpenAI Responses and the private release is repeatable.

- OpenAI Responses and Codex fake E2E.
- Continuation/retention policy.
- Clean install, CI, privacy, provenance/license, migration, and recovery verification.

Exit: independent review has no unresolved release blocker.

## Milestone 9 — Persistent per-user runtime service

Outcome: RLY runs as a per-user resident service installed once by `rly init`, stays alive after terminal/Claude Code exit, and is transparently reused by `rly <profile>`, config, and diagnostics.

- Resident ownership on the existing attested loopback gateway (service-owned lease; no second daemon/data plane).
- Per-user service registration: macOS LaunchAgent and Linux `systemd --user` through one service-manager contract (idempotent `rly init`).
- Identity/version handshake on `/identity` for #73 update decisions.
- Crash recovery, stale-record recovery, foreign-listener fail-closed, and bounded explicit shutdown.

Exit: lifecycle/service-manager/CLI gates and full `pnpm verify` pass; macOS launchd specifics delivered by #33 (per-user LaunchAgent, idempotent repair, bounded crash policy, no root), Linux systemd specifics remain #34.

## Beyond V1

See [BACKLOG.md](./BACKLOG.md). Nothing there is committed without promotion.

## Unresolved questions

- Release publishing target is selected only after the private clean-install release passes.
