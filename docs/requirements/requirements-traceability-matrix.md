# Requirements Traceability Matrix

## Business-to-acceptance trace

| Business requirement | System requirements | Functional requirements | Use cases / stories | Acceptance |
| --- | --- | --- | --- | --- |
| BR-001 Multiple providers through Claude | SR-F-001, SR-F-003, SR-F-009–012 | FR-008, FR-009, FR-011 | UC-001, UC-005; US-001, US-007 | AT-015–AT-022, AT-033 |
| BR-002 Central administration | SR-F-004/005/009/011/016/017 | FR-002, FR-007/008/013 | UC-004/006/007; US-004–US-006 | AT-003/004, AT-013–AT-016, AT-025/026 |
| BR-003 Credential ownership | SR-F-006–008, SR-NF-002/003/005/006/008 | FR-003–FR-006 | UC-002/003/006/008; US-002–US-004/010 | AT-005–AT-014 |
| BR-004 Reuse proven MIT code | SR-F-019, SR-NF-011/014 | FR-015 | UC-009; US-009 | AT-028, AT-030 |
| BR-005 Deterministic safe routing | SR-F-010–014, SR-NF-006/007/010/012 | FR-009/010/014 | UC-005/007; US-005/006 | AT-017–AT-020, AT-027 |
| BR-006 Claude first, Codex next | SR-F-001–003/015 | FR-011/012 | UC-001/005; US-007/008 | AT-021–AT-024 |
| BR-007 CLI and local UI | SR-F-009/016/017, SR-NF-004/013 | FR-008/013/014 | UC-001/004/007; US-001/005/006 | AT-015/016, AT-025–AT-027, AT-031, AT-033 |
| BR-008 Preserve native recovery/process safety | SR-F-015/018, SR-NF-001/004/008 | FR-001/011/012 | UC-001/008; US-001/010 | AT-001/002, AT-021–AT-026, AT-033 |
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

## Phase 65 executable evidence (persistent runtime service)

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-035 / FR-018 / SR-F-022 | `tests/lifecycle/resident-runtime.test.ts` | Verified resident lease prevents zero-lease idle shutdown after launcher release; concurrent launchers reuse one runtime with independent leases; explicit shutdown revokes sessions, closes listeners, and cleans artifacts; idempotent shutdown; authenticated `/shutdown` route; already-running resident is a no-op; foreign listener fails closed without authorization; stale-record recovery; stop refuses launcher-owned instances; bounded launcher drain |
| AT-035 service definitions | `tests/service-manager/definitions.test.ts`, `tests/service-manager/adapters.test.ts` | Verified LaunchAgent plist and systemd user unit content (absolute paths, restart-on-failure, no credentials/identity/env), idempotent register, launchctl/systemctl command sequences with fake runner, already-loaded tolerance, file modes, unsupported-platform actionability |
| AT-035 init/CLI | `tests/unit/cli-init.test.ts`, `tests/unit/cli-gateway.test.ts`, `tests/unit/cli-main.test.ts` | Verified `rly init` registers/starts service, writes `installation.json`, reports readiness, idempotent re-init, unsupported platform skip, readiness failure; `rly gateway start|stop|status` flows; reserved-command parsing |
| AT-035 identity handshake | `tests/lifecycle/gateway-server.test.ts`, `tests/lifecycle/gateway-lifecycle.test.ts` | Verified `/identity` carries `runtimeVersion` + `resident`; `inspectGateway` distinguishes `attested-incompatible` from `occupied-foreign`; `/shutdown` authz and 202-then-close |

## Maintenance rule

When a requirement changes, update its owning document and this matrix in the same change. When implementation completes, add the executable evidence reference without replacing the stable acceptance ID. If a Must requirement lacks downstream coverage or current evidence, the phase/release cannot be marked accepted.

## Current baseline status

- BR-001/006/008 have partial verified evidence from the completed Claude direct-provider milestone.
- Control-plane foundation evidence exists for schema/migrations, authenticated management, CLI administration, and secret-free DTOs.
- Credential broker and Codex OAuth evidence exists for import, login, refresh CAS, revoke, recovery, and a request-scoped Anthropic route. Request-time pool selection, Claude Code profile integration, and the secret-free local UI are implemented; `rly <profile>` is the canonical Claude Code alias and Codex CLI remains `rly run codex`.
- The model intelligence registry (`src/registry/model-registry.ts`) is the canonical model-data layer and the source of truth for #68-#72: exact access-provider identity, upstream model id/family, capability/limits/reasoning evidence, typed compatibility state, deterministic query helpers, and a discovery→proposal boundary that never mutates reviewed evidence (#23). `ProviderRecord.capabilityEvidence` is typed against the registry schema (was `unknown`).
- Exact evidence mapping is completed phase by phase; no pending row is represented as passing.

## Phase 23 executable evidence (propose-only catalog refresh, #23 / BL-042)

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-036 | `tests/unit/catalog-proposal.test.ts`, `tests/contract/providers/catalog-discovery.test.ts`, `tests/unit/proposal-store.test.ts`, `tests/unit/cli-admin.test.ts` | Verified deterministic drift engine (`proposeCatalogDrift`) with stable empty proposal on identical inputs; per-kind drift entries (new/removed/family/reasoning/limits/declared capability); cross-provider upstream-id separation; 250-model aggregator snapshot stays deterministic and activates nothing; fail-closed on mixed-provider and duplicate snapshots; OpenRouter API discovery (GET /models) with explicit normalization rules and optional env-ref auth; static reviewed-path source; schema-validated artifact persistence separate from trusted evidence; `rly admin models refresh|proposals` surfaces proposals with `trusted: false` and never mutates `directProviderRegistry` |
| AT-037 | `tests/contract/providers/catalog-discovery.test.ts`, `tests/unit/proposal-store.test.ts`, `tests/unit/catalog-proposal.test.ts` | Verified privacy-redacted upstream errors (bearer tokens / credential pairs / email stripped), secret-free report/artifact walks, and fail-closed reads of malformed artifacts |
| SR-F-004 / FR-002 capability evidence (unchanged) | `tests/control-plane/repositories.test.ts`, `tests/management/mutations.test.ts` | Verified unchanged after the proposal pipeline; refresh never writes control-plane state |
| Existing direct-route fail-closed behavior | `tests/contract/providers/direct-adapters.test.ts`, `tests/unit/model-registry.test.ts` | Verified unchanged: exact `(provider, model)` evidence only; unknown models still get no route |

## Phase 67 executable evidence (model foundation, #67)

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-034 | `tests/unit/model-registry.test.ts` | Verified canonical identity (access provider/upstream id/family), same-upstream-id-across-providers separation with fail-closed cross-provider lookup, aggregator multi-family projection, typed compatibility state separate from raw capability support, deterministic provider/family/capability/compatibility queries, registry revision bump (3→4), static legacy document migration, discovery→proposal non-mutation (#23), secret-free evidence |
| SR-F-004 / FR-002 capability evidence | `tests/control-plane/repositories.test.ts`, `tests/management/mutations.test.ts` | Verified typed `ProviderCapabilityEvidence` replaces `unknown`; management boundary validates the registry schema; stored-row parse fails closed |
| NX-004-equivalent (unchanged) | `tests/lifecycle/codex-profile-route.test.ts`, `tests/lifecycle/cline-profile-route.test.ts`, `tests/unit/model-registry.test.ts` | Verified exact `(codex, gpt-5.4)` and `(cline, claude-sonnet-4-5)` evidence still resolve after the schema change; missing/cross-provider evidence still fails closed |
| Existing Codex OAuth / ClinePass exact evidence | `tests/contract/providers/direct-adapters.test.ts`, lifecycle suites above | Verified unchanged behavior after the schema change |

## Phase 11 executable evidence

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-023 | `tests/contract/openai-responses/responses.test.ts`, `tests/e2e/codex/fake-upstream.e2e.test.ts` | Verified Responses text/function/reasoning/usage/continuation and Codex fake launcher E2E |
| AT-024 | `tests/contract/openai-responses/responses.test.ts`, `tests/integration/fake-upstream/openai-responses-route.test.ts` | Verified unknown required items/include fail closed; client abort binds the upstream signal |
| AT-032 | `tests/storage/retention.test.ts` | Verified versioned policy, expired class deletion, and interrupted-cleanup resume |
| AT-030 | `scripts/check-license.mjs`, `scripts/package-release.mjs`, `scripts/clean-install-smoke.mjs`, `tests/control-plane/migrations.test.ts` | Verified license/provenance inventory, private-path-free package, clean-install doctor, and existing migration restore |
| AT-001/002 Codex | `tests/lifecycle/child-launcher.test.ts`, `tests/lifecycle/global-config-isolation.test.ts` | Verified transient `CODEX_HOME` and byte-identical `~/.codex` |

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
| AT-009, AT-010 | `tests/credentials/refresh.test.ts`, `tests/credentials/store.test.ts` | Verified single-flight refresh commits one generation; stale commit cannot overwrite a newer record; crashed credential locks are reclaimed and live locks are not stolen |
| AT-011 | `tests/credentials/revoke.test.ts`, `tests/management/credentials.test.ts` | Verified revoke removes usable active/temp/backup project records and excludes the account |
| AT-012 | `tests/credentials/store.test.ts` | Verified corrupt active restores the last valid backup, or marks the handle unready |
| AT-013 subset | `tests/management/credentials.test.ts`, `tests/management/mutations.test.ts` | Verified pause/select/revoke and secret-free readiness on account DTOs |
| AT-014 subset | `src/credentials/service.ts` readiness | Terms-unaccepted accounts are unready for manual selection |
| Provider-scoped identity | `tests/credentials/identity.test.ts`, `tests/control-plane/repositories.test.ts`, `tests/control-plane/migrations.test.ts` | Verified `(provider, pseudonym)` uniqueness, cross-provider reuse, credential/provider mismatch fail-closed, and v2 migration keeps valid accounts |
| AT-027 subset | `tests/privacy/credentials.test.ts` | Verified DTO/audit/policy JSON contain no access or refresh material |
| Codex OAuth adapter | `tests/contract/providers/codex-oauth/adapter.test.ts`, `tests/credentials/route.test.ts` | Verified request-scoped secret use and one selected account bound into the Anthropic route |
| Live Codex smoke | `tests/contract/providers/codex-oauth/live-smoke.test.ts` | Skipped unless `RLY_LIVE_CODEX_OAUTH=1`; not passing evidence |

## Phase 08 executable evidence

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-014 request-time | `tests/routing/eligibility.test.ts` | Verified unaccepted and stale terms acknowledgement are ineligible; current required revision enables selection |
| AT-017 | `tests/routing/strategies.test.ts`, `tests/routing/effective-route.test.ts`, `tests/credentials/route.test.ts`, `tests/credentials/refresh.test.ts` | Verified deterministic manual/round-robin/fill-first selection binds one credential generation after refresh and before invoke |
| AT-018 | `tests/routing/eligibility.test.ts` | Verified paused, expired, unready, cooling, incompatible, and unaccepted candidates are excluded before strategy; exhausted without cooldown is a recovery probe |
| AT-019 | `tests/routing/retry.test.ts`, `tests/routing/outcomes.test.ts` | Verified pre-output auth/quota/transient failure records a transactional outcome; success restores healthy; probe failure extends cooldown |
| AT-020 | `tests/routing/retry.test.ts` | Verified failure after text or tool event does not invoke a second account |
| AT-027 subset | `tests/privacy/routing.test.ts` | Verified decision traces and outcome audit contain no secret or identity fields |
| SR-NF-006 / SR-NF-008 | `tests/routing/race.test.ts`, `tests/routing/restart.test.ts`, `tests/routing/outcomes.test.ts` | Verified selector isolation, durable pause/cooldown across restart, and interrupted health writes roll back |

## Phase 09 executable evidence

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-021 subset | `tests/lifecycle/profile-pool-route.test.ts`, `tests/e2e/claude-code/pool-profile.e2e.test.ts` | Verified text, helper mapping, and tools through a profile pool; real Claude E2E remains opt-in (`RLY_CLAUDE_E2E=1`) |
| AT-022 subset | `tests/lifecycle/profile-pool-route.test.ts`, `tests/unit/profiles.test.ts` | Verified concurrent child tokens and lease-drop invalidation; account is not bound at activation. Client abort remains covered by the Anthropic route bind test, not the profile inject suite |
| AT-027 subset | `tests/privacy/profiles.test.ts`, `tests/lifecycle/profile-pool-route.test.ts` | Verified route-trace and activation DTOs contain no credential, identity, prompt, response, or tool argument |
| Profile launch UX | `tests/unit/cli-main.test.ts`, `src/cli/main.ts` | Verified `--profile` is mutually exclusive with `--route` and uses a child token |
| Live Codex pool smoke | `tests/contract/providers/codex-oauth/live-smoke.test.ts` | Skipped unless `RLY_LIVE_CODEX_OAUTH=1` and a project-owned handle is provided; not passing evidence |

## Phase 10 executable evidence

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-025, AT-026 | `tests/ui/session.test.ts`, `tests/management/auth.test.ts` | Verified fragment exchange, CSRF rotate/resume, Origin/CSRF fail-closed, security headers |
| AT-027 subset | `tests/ui/page.test.ts`, `tests/ui/session.test.ts`, `tests/privacy/control-plane.test.ts` | Verified UI/HTML/DTO/traces contain no secrets, no browser storage, no file picker |
| AT-031 subset | `tests/ui/page.test.ts`, `tests/browser/at-031.spec.ts` | HTML/CSS plus Chromium: keyboard skip/save/logout, 375/1024 nav, labeled controls, textual status/alert, secret-free DOM. Remaining views (accounts/pools/profiles/traces/confirm) are not this issue. |
| Provider contracts | `tests/contract/providers/catalog.test.ts`, `tests/contract/providers/gemini-oauth.test.ts`, `tests/contract/providers/expansion.test.ts`, `tests/contract/providers/isolation.test.ts` | Verified Gemini/Claude OAuth, Antigravity bridge identity, Cline explicit lock/restore, OpenCode Go/Alibaba isolation |
| Live provider smoke | none in this phase | Opt-in live gates remain skipped; not passing evidence |

## Phase 2 executable evidence

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-033 | `tests/unit/cli-main.test.ts`, `tests/lifecycle/global-config-isolation.test.ts` | Verified `rly <profile>` launches Claude Code; reserved commands stay reserved; unknown profile fails closed; `rly run codex` unchanged; global Claude/Codex config byte-identical |

## Phase 3 executable evidence

| Acceptance | Evidence | Status |
| --- | --- | --- |
| NX-001 / FR-008 | `README.md`, `CONTRIBUTING.md` | Operator recipe: `codex` OAuth provider, login or explicit import, pool, Claude profile named `codex`, `rly codex`. `rly run codex` remains Codex CLI |
| AT-021 subset | `tests/lifecycle/codex-profile-route.test.ts`, `tests/e2e/claude-code/codex-oauth.e2e.test.ts` | Verified helper mapping, streaming, and tools through a Codex OAuth profile; Claude Code fake E2E is opt-in (`RLY_CLAUDE_E2E=1`) and skipped ≠ pass |
| AT-022 subset | `tests/e2e/claude-code/codex-oauth.e2e.test.ts` | Verified cancellation aborts the Codex fake upstream; no global Claude/Codex config mutation |
| AT-017 / AT-019 subset | `tests/lifecycle/codex-profile-route.test.ts` | Verified quota rotation and sticky session through existing pool machinery on a Codex profile |
| NX-004 | `tests/unit/model-registry.test.ts`, `tests/lifecycle/codex-profile-route.test.ts` | Verified exact `(codex, gpt-5.4)` evidence; OpenRouter ids and unknown Codex models fail closed; images fail closed |
| AT-027 subset / NX-005 | `tests/unit/cli-diagnostics.test.ts` | Verified `quota` and `route-trace` print only pseudonym, quota class, and decision reason for a Codex profile |
| NX-003 live | `tests/e2e/claude-code/codex-oauth-live.e2e.test.ts`, `tests/contract/providers/codex-oauth/live-smoke.test.ts` | Skipped unless `RLY_LIVE_CODEX_OAUTH=1` (and a project-owned handle / `claude` binary); not passing evidence |

## Phase 4 executable evidence

| Acceptance | Evidence | Status |
| --- | --- | --- |
| NX-012 / FR-003 / FR-008 / AT-005 subset | `README.md`, `CONTRIBUTING.md`, `tests/credentials/import.test.ts`, `tests/management/credentials.test.ts` | Verified operator recipe: `cline` provider with explicit endpoint, preview+import with `providerId`, pool, Claude profile named `clinepass`, `rly clinepass`. Preview without `providerId` is rejected. Import leaves the Cline source byte-identical and writes no lock/backup files |
| AT-021 subset | `tests/lifecycle/cline-profile-route.test.ts`, `tests/e2e/claude-code/cline-interop.e2e.test.ts` | Verified helper mapping, streaming, and tools through a ClinePass profile; Claude Code fake E2E is opt-in (`RLY_CLAUDE_E2E=1`) and skipped ≠ pass |
| AT-022 subset / NX-013 isolation | `tests/lifecycle/cline-profile-route.test.ts`, `tests/contract/providers/isolation.test.ts`, `tests/e2e/claude-code/cline-interop.e2e.test.ts` | Verified Cline failure does not mutate Codex credential files; Cline source remains unchanged |
| NX-004-equivalent | `tests/unit/model-registry.test.ts`, `tests/lifecycle/cline-profile-route.test.ts` | Verified exact `(cline, claude-sonnet-4-5)` evidence; Codex/OpenRouter ids and unknown Cline models fail closed; images fail closed |
| NX-014 live | `tests/e2e/claude-code/cline-interop-live.e2e.test.ts` | Skipped unless `RLY_LIVE_CLINEPASS=1`, `RLY_LIVE_CLINE_HANDLE`, `RLY_LIVE_CLINE_ENDPOINT`, and a `claude` binary; not passing evidence |
| NX-015 superseded | `src/credentials/broker.ts`, `src/providers/interop/cline.ts`, `tests/credentials/import.test.ts` | Default import remains one-time read-only. `lockClineInterop` / `backupClineSource` / `restoreClineSource` are not called from import or launch |
