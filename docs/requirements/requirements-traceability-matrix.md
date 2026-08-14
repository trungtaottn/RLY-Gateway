# Requirements Traceability Matrix

## Business-to-acceptance trace

| Business requirement | System requirements | Functional requirements | Use cases / stories | Acceptance |
| --- | --- | --- | --- | --- |
| BR-001 Multiple providers through Claude | SR-F-001, SR-F-003, SR-F-009–012 | FR-008, FR-009, FR-011 | UC-001, UC-005; US-001, US-007 | AT-015–AT-022 |
| BR-002 Central administration | SR-F-004/005/009/011/016/017 | FR-002, FR-007/008/013 | UC-004/006/007; US-004–US-006 | AT-003/004, AT-013–AT-016, AT-025/026 |
| BR-003 Credential ownership | SR-F-006–008, SR-NF-002/003/005/006/008 | FR-003–FR-006 | UC-002/003/006/008; US-002–US-004/010 | AT-005–AT-014 |
| BR-004 Reuse proven MIT code | SR-F-019, SR-NF-011/014 | FR-015 | UC-009; US-009 | AT-028, AT-030 |
| BR-005 Deterministic safe routing | SR-F-010–014, SR-NF-006/007/010/012 | FR-009/010/014 | UC-005/007; US-005/006 | AT-017–AT-020, AT-027 |
| BR-006 Claude first, Codex next | SR-F-001–003/015 | FR-011/012 | UC-001/005; US-007/008 | AT-021–AT-024 |
| BR-007 CLI and local UI | SR-F-009/016/017, SR-NF-004/013 | FR-008/013/014 | UC-001/004/007; US-001/005/006 | AT-015/016, AT-025–AT-027, AT-031 |
| BR-008 Preserve native recovery/process safety | SR-F-015/018, SR-NF-001/004/008 | FR-001/011/012 | UC-001/008; US-001/010 | AT-001/002, AT-021–AT-026 |
| BR-009 Privacy | SR-F-005/016/017/021, SR-NF-002–005/008/009/014 | FR-003–FR-007/013/014/017 | UC-002/003/006/007/008; US-002–US-006/010/011 | AT-005–AT-014, AT-025–AT-032 |
| BR-010 Terms/evidence gates | SR-F-004/005/010, SR-NF-012 | FR-002/007/009/015 | UC-003–UC-005/009; US-004/005/009 | AT-003/004, AT-014, AT-017/018, AT-028 |
| BR-011 Private history/public snapshot | SR-F-019/020, SR-NF-002/010/014 | FR-015/016 | UC-010; US-011/012 | AT-028–AT-030 |
| BR-012 Recoverability | SR-F-008/014/018/021, SR-NF-006/008/014 | FR-001/005/006/010/017 | UC-006/008; US-003/004/010 | AT-002, AT-009–AT-012, AT-019/020, AT-030/032 |

## Business-rule trace

| Rule | Downstream ownership | Acceptance |
| --- | --- | --- |
| BR-R01 Credential existence is not acceptance/readiness | SR-F-005/010; FR-007/009 | AT-014/018 |
| BR-R02 Only authorized owner/admin authenticates/imports | SR-F-006/007/016; FR-003/004/013 | AT-005–AT-008, AT-025/026 |
| BR-R03 One request binds one account/generation | SR-F-012; FR-009 | AT-017/018 |
| BR-R04 No rotation after output/tool event | SR-F-013; FR-010 | AT-019/020 |
| BR-R05 Unverified/incompatible route is unavailable | SR-F-003/004; FR-002/009 | AT-004/018/024 |
| BR-R06 Public snapshot excludes local/private artifacts | SR-F-019/020; FR-015/016 | AT-028–AT-030 |

## Maintenance rule

When a requirement changes, update its owning document and this matrix in the same change. When implementation completes, add the executable evidence reference without replacing the stable acceptance ID. If a Must requirement lacks downstream coverage or current evidence, the phase/release cannot be marked accepted.

## Current baseline status

- BR-001/006/008 have partial verified evidence from the completed Claude direct-provider milestone.
- Control-plane foundation evidence exists for schema/migrations, authenticated management, CLI administration, and secret-free DTOs.
- Credential broker and Codex OAuth evidence exists for import, login, refresh CAS, revoke, recovery, and a request-scoped Anthropic route. Request-time pool selection is implemented as a library engine; Claude Code pool integration, UI accessibility, and Codex harness remain unimplemented.
- Exact evidence mapping is completed phase by phase; no pending row is represented as passing.

## Phase 06 executable evidence

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-003, AT-004 | `tests/management/mutations.test.ts`, `tests/control-plane/repositories.test.ts` | Verified for versioned provider mutations and reject-closed stale/unauthorized cases |
| AT-013 | `tests/management/mutations.test.ts` | Verified pause/resume-style account update; DTO is pseudonym/readiness only |
| AT-014 | `tests/control-plane/repositories.test.ts` | Verified explicit terms acknowledgement against the required revision |
| AT-015, AT-016 | `tests/management/mutations.test.ts`, `tests/control-plane/repositories.test.ts` | Verified atomic profile/pool create and duplicate/cross-provider/stale rejection |
| AT-025, AT-026 | `tests/management/auth.test.ts`, `tests/management/mutations.test.ts` | Verified separate bearer, single-use fragment exchange, cookie flags, CSRF/Origin/replay/logout/stale-version fail-closed |
| AT-001, AT-002 management listener | `tests/lifecycle/management-lifecycle.test.ts`, `tests/lifecycle/gateway-lifecycle.test.ts` | Verified loopback management bind, foreign fail-closed, teardown, no port increment |
| SR-NF-002 / AT-027 subset | `tests/privacy/control-plane.test.ts`, `tests/control-plane/schema.test.ts` | Verified SQLite/DTO/audit have no secret or raw-identity columns |
| SR-NF-008 migration recovery | `tests/control-plane/migrations.test.ts` | Verified failed and interrupted migrations restore the prior schema |

## Phase 07 executable evidence

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-005, AT-006 | `tests/credentials/import.test.ts` | Verified explicit Codex import leaves the source byte-identical; malformed/oversized/changed sources fail without a usable project record |
| AT-007, AT-008 | `tests/credentials/oauth.test.ts` | Verified PKCE/S256 exact loopback login; state mismatch, replay after close, cancel, callback collision, and bounded token bodies fail closed |
| AT-009, AT-010 | `tests/credentials/refresh.test.ts`, `tests/credentials/store.test.ts` | Verified single-flight refresh commits one generation; stale commit cannot overwrite a newer record |
| AT-011 | `tests/credentials/revoke.test.ts`, `tests/management/credentials.test.ts` | Verified revoke removes usable active/temp/backup project records and excludes the account |
| AT-012 | `tests/credentials/store.test.ts` | Verified corrupt active restores the last valid backup, or marks the handle unready |
| AT-013 subset | `tests/management/credentials.test.ts`, `tests/management/mutations.test.ts` | Verified pause/select/revoke and secret-free readiness on account DTOs |
| AT-014 subset | `src/credentials/service.ts` readiness | Terms-unaccepted accounts are unready for manual selection |
| AT-027 subset | `tests/privacy/credentials.test.ts` | Verified DTO/audit/policy JSON contain no access or refresh material |
| Codex OAuth adapter | `tests/contract/providers/codex-oauth/adapter.test.ts`, `tests/credentials/route.test.ts` | Verified request-scoped secret use and one selected account bound into the Anthropic route |
| Live Codex smoke | `tests/contract/providers/codex-oauth/live-smoke.test.ts` | Skipped unless `AGENT_GATEWAY_LIVE_CODEX_OAUTH=1`; not passing evidence |

## Phase 08 executable evidence

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-014 request-time | `tests/routing/eligibility.test.ts` | Verified unaccepted and stale terms acknowledgement are ineligible; current required revision enables selection |
| AT-017 | `tests/routing/strategies.test.ts`, `tests/routing/effective-route.test.ts` | Verified deterministic manual/round-robin/fill-first selection binds one credential generation |
| AT-018 | `tests/routing/eligibility.test.ts` | Verified paused, expired, unready, exhausted, cooling, incompatible, and unaccepted candidates are excluded before strategy |
| AT-019 | `tests/routing/retry.test.ts`, `tests/routing/outcomes.test.ts` | Verified pre-output auth/quota/transient failure records a transactional outcome and rotates within budget |
| AT-020 | `tests/routing/retry.test.ts` | Verified failure after text or tool event does not invoke a second account |
| AT-027 subset | `tests/privacy/routing.test.ts` | Verified decision traces and outcome audit contain no secret or identity fields |
| SR-NF-006 / SR-NF-008 | `tests/routing/race.test.ts`, `tests/routing/restart.test.ts`, `tests/routing/outcomes.test.ts` | Verified selector isolation, durable pause/cooldown across restart, and interrupted health writes roll back |

## Phase 09 executable evidence

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-021 subset | `tests/lifecycle/profile-pool-route.test.ts`, `tests/e2e/claude-code/pool-profile.e2e.test.ts` | Verified text, helper mapping, and tools through a profile pool; real Claude E2E remains opt-in (`AGENT_GATEWAY_CLAUDE_E2E=1`) |
| AT-022 subset | `tests/lifecycle/profile-pool-route.test.ts`, `tests/unit/profiles.test.ts` | Verified concurrent child tokens and lease-drop invalidation; account is not bound at activation. Client abort remains covered by the Anthropic route bind test, not the profile inject suite |
| AT-027 subset | `tests/privacy/profiles.test.ts`, `tests/lifecycle/profile-pool-route.test.ts` | Verified route-trace and activation DTOs contain no credential, identity, prompt, response, or tool argument |
| Profile launch UX | `tests/unit/cli-main.test.ts`, `src/cli/main.ts` | Verified `--profile` is mutually exclusive with `--route` and uses a child token |
| Live Codex pool smoke | `tests/contract/providers/codex-oauth/live-smoke.test.ts` | Skipped unless `AGENT_GATEWAY_LIVE_CODEX_OAUTH=1` and a project-owned handle is provided; not passing evidence |
