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
- Safe zero-downtime runtime update lifecycle (#73): `rly update` separates candidate installation from activation through durable secret-free states, keeps existing sessions on the old process until a safe zero-session drain point (`--force` for the explicit destructive path), restarts only attested resident runtimes through the per-user service manager, verifies the new runtime via the authenticated identity/readiness handshake, rolls back once to the previous known-good version on failure, blocks forward-only migrations before destructive activation, serializes concurrent updates with an ownership-aware stale-reclaimable lock, recovers crash/reboot states deterministically, and exposes allowlisted version/update metadata in `status`/`doctor`; candidate distribution/signing stays #35 (BACKLOG).
- `rly config` user control plane (#66): durable `~/.rly` configuration resolution (no CWD `gateway.config.toml`), resident-runtime ensure/recover, secret-free status, local config UI bootstrap (fragment token, loopback-only), and focused provider/account/pool/profile shortcuts over the same management API as `rly admin`.
- Crash recovery, stale-record recovery, foreign-listener fail-closed, and bounded explicit shutdown.

Exit: lifecycle/service-manager/CLI gates and full `pnpm verify` pass; macOS launchd specifics delivered by #33 (per-user LaunchAgent, idempotent repair, bounded crash policy, no root) and Linux systemd specifics delivered by #34 (per-user `systemd --user` unit, user-manager bus probe, bounded `StartLimit` restart policy, no root, no auto-linger).

## Milestone 10 — Runtime compatibility canary (BL-043 / #24)

Outcome: newly installed Claude Code / Codex CLI versions are never auto-supported; every access path carries reviewed runtime compatibility evidence.

- Exact installed client version reporting separate from binary `found` (version parsed from `--version`; unknown never inferred).
- Pinned baseline wire-contract fixtures (attribution headers, `/v1/models` discovery incl. id-prefix filter and startup cache, tier aliases incl. `fable`, subagent/session `effort`, streaming framing, `--no-session-persistence`) and a deterministic fake gate matrix (text, streaming, cancellation, tools, reasoning, reasoning+tools, model discovery, subagent routing, parallel subagents, effort signal, long-running sessions).
- Per-access-path `VERIFIED`/`EXPERIMENTAL`/`BROKEN`/`unknown` classification with no cross-provider evidence reuse; #72 projection gating consumes canary-derived state (VERIFIED default, EXPERIMENTAL opt-in, BROKEN never).
- `rly canary run|status` secret-free evidence artifacts for #23/#67 review; `rly doctor` reports versions + tested baseline; live provider runs stay opt-in (`RLY_LIVE_CANARY=1`, skipped ≠ pass).

Exit: canary matrix/evidence/CLI/projection-gate/privacy suites and full `pnpm verify` pass.

## Milestone 11 — Wave 4 service/identity boundary (#92/#93/#94)

Outcome: installed runtime execution is immutable, transactionally activated, and bound to an exact build identity — activation/rollback verify the exact bytes now serving.

- Immutable content-addressed deployments + atomic `staged`/`active`/`previous` refs; INSTALL != ACTIVATE; legacy layout migration (#92).
- Transactional activation with durable journal phases, real-identity update lock, drain fence, migration compatibility classes, bounded rollback, deterministic crash recovery (#93).
- Stable RLY-owned bootstrap contract (`<control-plane>/bootstrap/rly-gateway`) as the sole service-manager execution identity (never `dist/cli/init.js`/Node path); exact build identity (semantic version/commit/build ID/channel/protocol/state versions/artifact digest) shared by `/identity`, `rly --version`, diagnostics, manifest, and probation; build-aware attestation fail-closed; idempotent service-definition reconciliation (#94).

## Beyond V1

See [BACKLOG.md](./BACKLOG.md). Nothing there is committed without promotion.

## Unresolved questions

- Release publishing target is selected only after the private clean-install release passes.
