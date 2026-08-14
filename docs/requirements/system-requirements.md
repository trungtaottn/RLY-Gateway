# System Requirements Specification

## Purpose and boundary

This SRS defines externally verifiable system behavior for the local RLY Gateway product. Detailed business rationale belongs to the [BRD](./business-requirements.md); detailed flows belong to the [FRS](./functional-requirements.md); architecture decisions belong to accepted ADRs.

## Actors and external systems

- Owner/operator using CLI or local UI.
- Claude Code as the coding harness; Codex CLI only through `rly run codex`.
- Direct provider APIs and subscription-backed OAuth services.
- Optional attested local bridges.
- Existing Codex/Cline credential stores used only through explicit import/interoperability modes.
- macOS process, filesystem, loopback network, and optional Keychain facilities.

## Functional requirements

| ID | System requirement | Priority | Verification |
| --- | --- | --- | --- |
| SR-F-001 | Decode and encode supported Anthropic Messages semantics without silent loss. | Must | Protocol contracts and Claude E2E |
| SR-F-002 | Decode and encode supported OpenAI Responses semantics without reducing them to Anthropic ordering. | Must | Responses contracts and Codex E2E |
| SR-F-003 | Derive required capabilities before any upstream invocation and reject incompatible routes. | Must | Capability-negative tests |
| SR-F-004 | Manage provider definitions and evidence-dated model/capability records. | Must | Management/API validation |
| SR-F-005 | Manage account metadata independently from credential secrets. Account identity is unique per `(provider, pseudonym)`. | Must | Schema and DTO inspection |
| SR-F-006 | Explicitly import credentials without modifying the source store by default. | Must | Import immutability tests |
| SR-F-007 | Perform project-owned OAuth login, refresh, logout, and revoke through a central credential broker. | Must | OAuth lifecycle tests |
| SR-F-008 | Persist credential generations atomically and recover the last valid state after interruption, including reclaiming crashed credential locks without stealing live owners. | Must | Crash/corruption recovery tests |
| SR-F-009 | Manage profiles that bind harness, provider/pool, model roles, capability policy, and launch policy. The profile name is the canonical Claude Code launch alias (`rly <profile>`). | Must | Profile validation/E2E |
| SR-F-010 | Filter account eligibility before applying a pool selection strategy. | Must | Pool invariant tests |
| SR-F-011 | Support manual pin, round-robin, fill-first, bounded affinity, pause, and cooldown. | Must | Deterministic selector tests |
| SR-F-012 | Create one immutable request-scoped EffectiveRoute containing policy revision, capability snapshot, account pseudonym, and the credential generation frozen after refresh and before invoke. | Must | Route isolation tests |
| SR-F-013 | Permit bounded retry/account rotation only before the first response byte or tool event. | Must | Retry-boundary tests |
| SR-F-014 | Update health, quota class, cooldown, and audit outcome transactionally. Success restores healthy; quota exhaustion is ineligible only while cooling and becomes a recovery probe afterward. | Must | Outcome/crash tests |
| SR-F-015 | Launch Claude Code via `rly <profile>` or `rly run claude`, and Codex CLI via `rly run codex` only, with transient configuration that preserves global client configuration. | Must | Before/after hash E2E |
| SR-F-016 | Expose authenticated CLI management and a versioned local management API. | Must | Auth/mutation contract tests |
| SR-F-017 | Provide a local UI that consumes secret-free management DTOs only. | Must | Browser/network/privacy tests |
| SR-F-018 | Detect/reuse only attested project processes and fail closed on foreign listeners. | Must | Lifecycle/port tests |
| SR-F-019 | Record exact provenance and required notices for substantially reused source. | Must | Release provenance inspection |
| SR-F-020 | Produce a public release snapshot without connecting private `dev` history to public `main`. | Must | Git topology verification |
| SR-F-021 | Apply versioned retention and deletion policy to logs, audit, continuation state, backups, revoked credentials, and migration artifacts. | Must | Retention/deletion acceptance tests |
| SR-F-022 | Bootstrap and operate a per-user resident runtime service: idempotent `rly init`, macOS LaunchAgent / Linux `systemd --user` registration without root, a service-owned lease that prevents zero-lease idle shutdown while the service is intentional, independent launch/session leases, an identity/version handshake, crash/stale-record recovery, and bounded explicit shutdown that never signals an unknown port owner. | Must | Service-manager, lifecycle, and CLI tests |
| SR-F-023 | Operate the `rly config` user control plane: durable `~/.rly` configuration resolution (no CWD `gateway.config.toml` on the normal installed path), resident-runtime ensure/recover, secret-free status, loopback UI bootstrap, and provider/account/pool/profile operations through the same management API and policy revision as `rly admin`. | Must | Config CLI unit/lifecycle tests |
| SR-F-024 | Compose a durable RLY-owned Claude configuration overlay for RLY-launched Claude sessions: one private namespace under the durable RLY home (`<control-plane>/claude`); native user Claude config is read/compose-only input composed through a typed allowlist (settings merge, user agents/commands/skills, plugin enablement declaration); RLY-only gateway model state persists only inside the overlay so a later plain `claude` launch never inherits RLY gateway env, auth, or projection model ids; RLY session/history state survives RLY launches; composition is atomic, deterministic, and concurrent-RLY-launch safe; native Claude config is never rewritten and `~/.claude.json` and project-local `.claude` remain untouched. | Must | Overlay unit/lifecycle and before/after hash tests |

## Non-functional requirements

| ID | Requirement | Target or invariant | Verification |
| --- | --- | --- | --- |
| SR-NF-001 | Local network isolation | Data `127.0.0.1:17871`; management `127.0.0.1:17872`; no port auto-increment | Listener/collision tests |
| SR-NF-002 | Secret confidentiality | No raw secret in Git, SQLite, UI/DTO, log, audit, error, fixture, or package | Privacy/secret scans |
| SR-NF-003 | Credential file protection | Store `0700`; files `0600`; correct owner; atomic replace | Mode/owner/crash tests |
| SR-NF-004 | Management security | Separate per-instance secret; exact Origin; CSRF; short sessions; logout/shutdown invalidation | Negative security tests |
| SR-NF-005 | OAuth security | PKCE, exact redirect, single-use expiring state, replay rejection, bounded errors | OAuth negative tests |
| SR-NF-006 | Concurrency correctness | Single-flight refresh; generation CAS; request/pool isolation | Race tests |
| SR-NF-007 | Stream safety | No retry/rotation after externally visible output/tool event | Adversarial stream tests |
| SR-NF-008 | Recoverability | Verified backups/migrations; last valid credentials and metadata recoverable | Crash/restart tests |
| SR-NF-009 | Privacy by default | Prompt, response, tool argument, email, and raw identity excluded from default observability | Adversarial redaction tests |
| SR-NF-010 | Traceability | Every Must BR maps to system, functional, and acceptance IDs | RTM audit |
| SR-NF-011 | Maintainability | Provider behavior isolated behind explicit adapter/credential/protocol contracts | Architecture review |
| SR-NF-012 | Compatibility | Unknown required protocol/provider behavior fails closed and downgrades readiness | Drift fixtures |
| SR-NF-013 | Accessibility | Local UI supports keyboard navigation, visible focus, labels, status text, and responsive layouts | Browser accessibility checks |
| SR-NF-014 | Release integrity | Full verify, privacy, license/provenance, migration/recovery, package and clean-install gates pass | Release gate |

## Data requirements

- SQLite stores non-secret provider, account metadata, profile, pool, membership, health, policy revision, terms revision/acceptance, and metadata-only audit records.
- Credential store contains versioned project-owned secret records and temporary atomic-write artifacts; it is outside Git and SQLite.
- Runtime ownership/lease/session state is separate from durable control-plane metadata.
- Default logs and audit do not contain request bodies or account identity.
- SR-F-021 owns retention/deletion policy. Exact durations and budgets are versioned policy values approved before release.

## External interface requirements

- Data API: protocol-native endpoints authenticated with the transient harness token.
- Management CLI: per-instance bearer read from restrictive runtime state.
- Management browser: launcher fragment bootstrap exchanged for an `HttpOnly`, `SameSite=Strict` cookie; exact Origin and CSRF required.
- Provider interfaces: documented direct API, project-owned OAuth, explicit interoperability, or attested bridge, selected per provider.
- Configuration import/export: metadata and handles only; never raw credentials.
- Per-user service managers: macOS launchd (user LaunchAgent) and Linux `systemd --user` with injectable command runners; definitions contain absolute executable/entrypoint/config paths only and never credentials or account identity.

## Assumptions

- One local owner in V1; authorization roles beyond owner/admin are future scope.
- Loopback is necessary but insufficient for management trust.
- Provider quota quality varies; unknown quota never fabricates availability.
- Filesystem deletion does not guarantee forensic erasure.

## Unresolved questions

- Quantitative performance targets after the first control-plane benchmark.
- Final retention durations and maximum local storage budgets.
- Exact supported OS matrix after the macOS private release.
