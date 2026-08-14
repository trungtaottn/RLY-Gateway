# Requirements Traceability Matrix

## Business-to-acceptance trace

| Business requirement | System requirements | Functional requirements | Use cases / stories | Acceptance |
| --- | --- | --- | --- | --- |
| BR-001 Multiple providers through Claude | SR-F-001, SR-F-003, SR-F-009–012, SR-F-025 | FR-008, FR-009, FR-011, FR-021 | UC-001, UC-005; US-001, US-007 | AT-015–AT-022, AT-033, AT-073–AT-083 |
| BR-002 Central administration | SR-F-004/005/009/011/016/017/023 | FR-002, FR-007/008/013, FR-019 | UC-004/006/007; US-004–US-006 | AT-003/004, AT-013–AT-016, AT-025/026, AT-048–AT-052 |
| BR-003 Credential ownership | SR-F-006–008, SR-NF-002/003/005/006/008 | FR-003–FR-006 | UC-002/003/006/008; US-002–US-004/010 | AT-005–AT-014 |
| BR-004 Reuse proven MIT code | SR-F-019, SR-NF-011/014 | FR-015 | UC-009; US-009 | AT-028, AT-030 |
| BR-005 Deterministic safe routing | SR-F-010–014, SR-NF-006/007/010/012, SR-F-025 | FR-009/010/014, FR-021 | UC-005/007; US-005/006 | AT-017–AT-020, AT-027, AT-073–AT-083 |
| BR-006 Claude first, Codex next | SR-F-001–003/015 | FR-011/012 | UC-001/005; US-007/008 | AT-021–AT-024 |
| BR-007 CLI and local UI | SR-F-009/016/017/023, SR-NF-004/013 | FR-008/013/014, FR-019 | UC-001/004/007; US-001/005/006 | AT-015/016, AT-025–AT-027, AT-031, AT-033, AT-048–AT-052 |
| BR-008 Preserve native recovery/process safety | SR-F-015/018, SR-NF-001/004/008, SR-F-024 | FR-001/011/012, FR-020 | UC-001/008; US-001/010 | AT-001/002, AT-021–AT-026, AT-033, AT-057–AT-072 |
| BR-009 Privacy | SR-F-005/016/017/021, SR-NF-002–005/008/009/014, SR-F-024, SR-F-025 | FR-003–FR-007/013/014/017, FR-020, FR-021 | UC-002/003/006/007/008; US-002–US-006/010/011 | AT-005–AT-014, AT-025–AT-032, AT-057–AT-064, AT-073–AT-083 |
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

## Phase 33 executable evidence (macOS launchd adapter, #33)

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-036 / FR-018 / SR-F-022 definitions | `tests/service-manager/definitions.test.ts` | Verified plist renders stable Label, absolute ProgramArguments, RunAtLoad, KeepAlive, explicit bounded ThrottleInterval, WorkingDirectory, StandardOut/ErrPath; no credentials/env/account identity; WorkingDirectory omitted unless provided |
| AT-036 / FR-018 / SR-F-022 adapter | `tests/service-manager/adapters.test.ts` | Verified idempotent register without duplicate labels; changed-definition repair unloads before reloading; unchanged re-registration stays a no-op reload; launchctl v2 bootstrap/kickstart/bootout/print with legacy load/start/unload/list fallback; restart via `kickstart -k`; status parses `state = running` and pid from `print` (and legacy `list`); loaded-but-not-running reports stopped; stop tolerates an unloaded job; root refusal; 0600 plist / 0700 LaunchAgents dir; unregister removes only the RLY plist |
| AT-036 init/CLI | `tests/unit/cli-init.test.ts`, `tests/unit/cli-gateway.test.ts` | Verified `rly init` passes the durable log path (`~/.rly/logs/service.log`) and working directory into the adapter; `rly gateway status` reports service label/load state/pid on macOS separately from runtime readiness; secret-free output |
| AT-036 live smoke | `tests/service-manager/launch-agent-live.test.ts` | macOS-only, opt-in `RLY_LIVE_LAUNCHAGENT_SMOKE=1`; skipped ≠ pass. Proves real launchd bootstrap → running → idempotent start → restart → stop → unregister in a GUI user session when CI/runtime permits |

## Phase 68 executable evidence (capability based model selection, #68)

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-044 | `tests/unit/model-selection.test.ts` | Verified deterministic selection from trusted registry evidence only: one eligible candidate; stable document-order tie-break with identical-input determinism; same upstream model id through two access providers stays provider-scoped (cross-provider exact lookup fails closed); aggregator multi-family candidate retrieval with preferred-family filtering; required protocol capabilities evaluated before ranking via existing `missingCapabilities`; reasoning intent eligibility against `ReasoningCapabilityEvidence` (required and reasoning-with-tools); BROKEN always rejected; EXPERIMENTAL rejected by the default normal-user candidate policy and allowed with explicit opt-in; frozen, secret-free decision trace with allowlisted keys only |
| AT-045 | `tests/unit/model-selection.test.ts`, `tests/lifecycle/profile-pool-route.test.ts`, `tests/lifecycle/codex-profile-route.test.ts` | Verified two-stage boundary: `resolveProfileRoute` runs `selectModel` before `RouteSelector`; the selected physical model is frozen in the effective request/route and fed to the account selector; `/v1/route-traces` carries the `modelSelection` decision beside the account decision; existing pool eligibility/affinity/quota/credential-generation behavior and Codex/Cline exact-evidence routes remain unchanged |
| AT-046 | `tests/unit/model-selection.test.ts`, `tests/lifecycle/codex-profile-route.test.ts` | Verified typed failure taxonomy (`unknown-exact-model`, `no-trusted-evidence`, `capability-unsupported`, `reasoning-unsupported`, `compatibility-rejected`, `no-eligible-candidate`) mapped deliberately onto the existing `capability-rejected` profile error contract with the actionable reason attached; no silent substitution or downgrade |
| AT-047 | `tests/unit/model-selection.test.ts`, `tests/lifecycle/profile-pool-route.test.ts` | Verified exact physical model path: exact pins resolve to the exact registry entry without rerouting, validate required capabilities and compatibility, reject BROKEN pins, and treat an explicit EXPERIMENTAL pin as an opt-in for that exact model; unknown pins fail closed |
| SR-F-004 / FR-009 / FR-010 / BR-005 (unchanged) | `tests/routing/*`, `tests/lifecycle/*`, `tests/unit/router.test.ts` | Verified `decideRoute` capability assertion, account eligibility → strategy → immutable `EffectiveRoute`, and pre-output bounded rotation semantics unchanged after the model-selection stage was added |

## Phase 70 executable evidence (provider-neutral reasoning intelligence layer, #70)

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-053 | `tests/unit/reasoning-translate.test.ts`, `tests/contract/providers/direct-adapters.test.ts`, `tests/unit/model-registry.test.ts` | Verified deterministic provider-owned translation boundary: six-level discrete, two-level, binary, adaptive, token-budget (reviewed policy only, else fail closed), and unsupported control shapes; exact same-family source effort preserved; intent→nearest-level deterministic mappings with explicit `exact|normalized|downgraded|default` metadata and fallback reasons; `OFF`/`AUTO` delegation; unsupported explicit intents fail closed (`unsupported-reasoning`) unless an explicit best-effort policy downgrades with a recorded reason; secret-free frozen result |
| AT-054 | `tests/contract/anthropic/messages.test.ts`, `tests/fixtures/upstream/claude-code/reasoning-shape.json`, `tests/contract/openai-responses/responses.test.ts` | Verified decoder fidelity: Anthropic `thinking.type` + documented additive `effort` decode into canonical `ReasoningRequest` preserving `sourceMode`/`sourceEffort`; pinned supported-baseline fixture drives the decoder (no assumed field names); unknown additive fields recorded as ignored; Responses `reasoning.effort` preserved instead of collapsed; existing thinking/redacted-thinking/streaming/tool behavior unchanged |
| AT-055 | `tests/unit/reasoning-translate.test.ts`, `tests/lifecycle/profile-pool-route.test.ts`, `tests/integration/direct-provider-runtime.test.ts`, `tests/contract/providers/direct-adapters.test.ts` | Verified routing wiring: `resolveRoute`/`decideRoute`/effective routes carry the translation result; `/v1/route-traces` carries allowlisted requested/canonical/effective/mapping/fallback metadata and no reasoning text, prompts, responses, or credentials; OpenRouter/direct adapter emits the provider-native parameter from the translation result and no longer collapses `enabled`/`adaptive`; binary evidence still emits `reasoning.enabled`, discrete evidence emits native effort |
| AT-056 | `tests/unit/model-selection.test.ts`, `tests/lifecycle/profile-pool-route.test.ts` | Verified #68 gate wiring: explicit non-`OFF`/non-`AUTO` intent plus tool use requires `reasoningWithTools` evidence (`withTools`); unsupported coexistence fails closed with `reasoning-unsupported`; eligibility and model-selection behavior otherwise unchanged |
| SR-F-004 / FR-009 / FR-010 / BR-005 (unchanged) | `tests/routing/*`, `tests/lifecycle/*`, `tests/unit/router.test.ts` | Verified route/account selection, immutable route, and rotation semantics unchanged after the reasoning translation stage was added |

## Phase 69 executable evidence (provider/family-scoped model tier resolver, #69)

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-057 | `tests/unit/tier-resolver.test.ts` | Verified `haiku`/`sonnet`/`opus`/`fable` typed separately from physical model ids with stable parsing; `TierResolutionContext` carries access provider + parent model/model family; resolution receives both provider and family context when available |
| AT-058 | `tests/unit/tier-resolver.test.ts` | Verified direct single-family provider resolves every tier to the deterministic #68 winner inside that provider (derived); provider without an eligible same-family target fails closed `tier-unavailable`; no silent cross-provider substitution |
| AT-059 | `tests/unit/tier-resolver.test.ts`, `tests/lifecycle/cline-profile-route.test.ts` | Verified ClinePass aggregator fixtures: Terra-family parent + `fable` → `gpt-5.6-sol` (not Anthropic/DeepSeek); DeepSeek V4 Flash parent + `fable` → `deepseek-v4-pro`; Anthropic parent + `fable` → `claude-fable` (stays in Anthropic family); end-to-end `model: fable` through a ClinePass profile reaches upstream as `gpt-5.6-sol` |
| AT-060 | `tests/unit/tier-resolver.test.ts`, `tests/lifecycle/profile-pool-route.test.ts` | Verified no same-family target + fallback disabled fails closed `tier-unavailable` (HTTP `tier-unavailable` + reason on an all-EXPERIMENTAL family); cross-family fallback only when explicitly enabled and recorded in the trace; cross-provider fallback requires an explicit provider list |
| AT-061 | `tests/unit/tier-resolver.test.ts`, `tests/control-plane/repositories.test.ts`, `tests/unit/profiles.test.ts` | Verified user override pins a tier target (`override-rejected` for unknown/BROKEN targets); reviewed mapping without trusted evidence fails closed `mapping-invalid`; `profile.modelRoles` accepts tier keys as per-profile overrides and rejects unknown keys |
| AT-062 | `tests/unit/tier-resolver.test.ts` | Verified default tier mapping is a frozen revisioned document; resolution records `mappingRevision` + `registryRevision`; identical inputs resolve identically; catalog refresh (#23) never mutates trusted tier mappings (BL-042 wording sharpened) |
| AT-063 | `tests/unit/tier-resolver.test.ts`, `tests/lifecycle/cline-profile-route.test.ts` | Verified tier target passes #68 exact selection (trace `modelSelection.source = exact`) then the existing pool/account selector; tier resolution never selects accounts/credentials and never emits provider-native reasoning fields |
| AT-064 | `tests/unit/tier-resolver.test.ts`, `tests/lifecycle/cline-profile-route.test.ts`, `tests/unit/profiles.test.ts`, `tests/lifecycle/profile-pool-route.test.ts` | Verified secret-free tier traces (requested tier, provider, family, parent, mapping source, selected target, fallback reason; no prompt/credential/identity keys); existing `primary`/`fast`/`reasoning` helper mapping and Codex/Cline/profile-pool routes unchanged; #24/#71 still own the supported Claude Code baseline's native `fable` alias classification |

## Phase 34 executable evidence (Linux systemd user service, #34)

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-040 / FR-018 / SR-F-022 definitions | `tests/service-manager/definitions.test.ts` | Verified systemd user unit renders stable Description, absolute ExecStart, `Restart=on-failure` + explicit `RestartSec`, bounded `StartLimitIntervalSec`/`StartLimitBurst`, optional WorkingDirectory and `StandardOutput/StandardError=append:` into the durable RLY log dir, systemd `%` specifier doubling and whitespace quoting; no credentials/env/account identity; optional blocks absent unless provided |
| AT-040 / FR-018 / SR-F-022 adapter | `tests/service-manager/adapters.test.ts` | Verified no-root guard; user-manager bus probe before any mutating op with actionable no-user-manager error (containers/WSL guidance, deliberate no `loginctl enable-linger`); idempotent register with change-only `daemon-reload`; stale-definition repair without duplicate units; `enable --now` start, `restart` for the #73 controlled-restart path, stop tolerating not-loaded; `detail()` parses `systemctl --user show` ActiveState/MainPID/UnitFileState into registered/loaded/running/pid/enabled/activeState; failed unit state surfaced; unreachable manager reports registered-but-unconfirmed instead of loaded; unregister `disable --now` + removes only the RLY unit + `daemon-reload`; 0600 unit / 0700 dir; secret-free unit content |
| AT-040 / FR-018 / SR-F-022 CLI | `tests/unit/cli-gateway.test.ts`, `tests/unit/cli-init.test.ts` | Verified `rly gateway status` reports Linux systemd service label/load state/pid/enabled separately from runtime readiness; init passes durable log/working paths into the adapter |
| AT-040 live smoke | `tests/service-manager/systemd-user-live.test.ts` | Linux-only, opt-in `RLY_LIVE_SYSTEMD_SMOKE=1`; skipped ≠ pass. Proves real `systemd --user` register → enable/start → running → restart → stop → unregister in a logged-in user session when CI/runtime permits |

## Phase 66 executable evidence (`rly config` control plane, #66)

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-048 / FR-019 / SR-F-023 | `tests/unit/cli-config.test.ts` | Verified durable config resolution from the `~/.rly` installation record (recorded absolute config path), schema-defaults fallback for a missing recorded file, explicit `--config` and CWD dev fallback, and an actionable uninitialized error; `rly config` runs from an unrelated working directory against a live management listener without any local `gateway.config.toml` |
| AT-049 / FR-019 / SR-F-023 | `tests/unit/cli-config.test.ts`, `tests/lifecycle/config-recovery.test.ts` | Verified resident-runtime ensure/recover: reuse of an attested compatible runtime (resident or launcher-owned), service-manager start + bounded readiness wait when the registered service is down, session-scoped foreground fallback, occupied-foreign and attested-incompatible fail-closed; a real resident runtime stays attested after `rly config` returns (closing the UI does not stop it) |
| AT-050 / FR-019 / SR-F-023 | `tests/unit/cli-config.test.ts`, `tests/lifecycle/config-recovery.test.ts` | Verified user-facing provider/account/pool/profile create/list through the same management endpoints as `rly admin`; a `rly config` provider mutation publishes one policy revision readable by the admin/management surface; multi-account and provider-scoped pool membership remain governed by the control-plane store |
| AT-051 / FR-019 / SR-F-023 | `tests/unit/cli-config.test.ts`, `tests/management/credentials.test.ts` | Verified credential login/import/refresh/revoke flows reuse the credential broker and persist only handle/generation metadata; stale versioned mutations surface `stale-version` explicitly and exit non-zero |
| AT-052 / FR-019 / SR-F-023 | `tests/unit/cli-config.test.ts`, `tests/lifecycle/config-recovery.test.ts`, `tests/privacy/*` | Verified headless bootstrap URL behavior (fragment token, no browser in `--headless`), loopback-only management, and secret-free CLI output (no token/secret/authorization/email/identity keys); the shared management client keeps `rly admin` and `rly config` on one API/policy source of truth |

## Phase 74 executable evidence (RLY Claude configuration overlay, #74)

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-065 / FR-020 / SR-F-024 | `tests/lifecycle/claude-overlay.test.ts`, `tests/lifecycle/child-launcher.test.ts`, `tests/e2e/claude-code/overlay.e2e.test.ts` | Verified one durable private namespace `<control-plane>/claude` with `0700` dirs/`0600` files; `launchClaude(configDirectory)` uses the durable overlay and never removes it, while the undefined-`configDirectory` standalone fallback keeps the throwaway temp isolation; the interactive launch contract (`runHarnessCommand`) always prepares and passes the overlay and fails on overlay errors instead of falling back to a sandbox; typed allowlist composition (settings merge, agents/commands/skills refresh, plugin enablement declaration); gated real-Claude E2E (`RLY_CLAUDE_E2E=1`, skipped ≠ pass) |
| AT-066 / FR-020 / SR-F-024 | `tests/lifecycle/claude-overlay.test.ts`, `tests/e2e/claude-code/overlay.e2e.test.ts` | Verified native settings one-way merge: unrelated keys and native `model` preserved in the overlay, gateway-conflict `env` keys stripped, native settings file hash unchanged after launch and simulated `/model` activity |
| AT-067 / FR-020 / SR-F-024 | `tests/lifecycle/claude-overlay.test.ts`, `tests/e2e/claude-code/overlay.e2e.test.ts` | Verified `agents/*.md`, `commands/*.md`, and `skills/**` one-way refresh copies with allowlist only; unknown extensions, `plugins/cache`, and unrelated files never copied; `node_modules`/`.git` excluded from skills recursion; native fixtures byte-identical |
| AT-068 / FR-020 / SR-F-024 | `tests/lifecycle/claude-overlay.test.ts`, `tests/e2e/claude-code/overlay.e2e.test.ts` | Verified `plugins/config.json` carries only `enabledPlugins`/`marketplaces`; `oauthAccounts`/token-like keys and plugin cache/repos never copied; no RLY auth or provider credential material in overlay files |
| AT-069 / FR-020 / SR-F-024 | `tests/lifecycle/claude-overlay.test.ts`, `tests/e2e/claude-code/overlay.e2e.test.ts` | Verified RLY-only projection model (`claude-rly-*`) persisted into the overlay only; native plain-Claude model/hash unchanged; overlay settings contain no `ANTHROPIC_BASE_URL`/auth token/projection leakage that a plain launch could inherit |
| AT-070 / FR-020 / SR-F-024 | `tests/lifecycle/claude-overlay.test.ts`, `tests/e2e/claude-code/overlay.e2e.test.ts` | Verified RLY model/session state survives re-prepare and relaunch when native input is unchanged; native changes re-compose one-way while RLY-only model state wins; durable overlay never deleted on child exit; project-local `.claude` untouched (home-level `~/.claude.json` sentinel byte-identical) |
| AT-071 / FR-020 / SR-F-024 | `tests/lifecycle/claude-overlay.test.ts` | Verified concurrent `prepareClaudeOverlay` calls converge to one consistent overlay without locks or corruption; unchanged native input is not rewritten so sibling `/model` writes survive; no copy-back/restore of native settings anywhere |
| AT-072 / FR-020 / SR-F-024 | `tests/lifecycle/claude-overlay.test.ts`, `tests/unit/cli-diagnostics.test.ts` | Verified private permissions, secret-free `readClaudeOverlayStatus` (directory/source/allowlistVersion/lastComposedAt only), `rly status` overlay summary, and no credential/identity material in overlay files or diagnostics |
| SR-F-015 (unchanged) | `tests/lifecycle/global-config-isolation.test.ts` | Verified the before/after-hash global-isolation contract still holds with real overlay preparation against a temporary HOME (native Claude/Codex config byte-identical) |

## Phase 72 executable evidence (gateway model discovery and projection, #72)

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-073 / FR-021 / SR-F-025 | `tests/lifecycle/gateway-models-route.test.ts`, `tests/unit/model-projection.test.ts` | Verified authenticated `GET /v1/models` on the gateway listener with the Anthropic-compatible discovery shape (`type`/`id`/`display_name`/`created_at`, `has_more`/`first_id`/`last_id`) and `limit`/`before_id`/`after_id` pagination; 401 without launch/gateway credentials; session token serves the pinned universe while the instance bearer serves the policy-derived universe; secret-free discovery bodies |
| AT-074 / FR-021 / SR-F-025 | `tests/lifecycle/child-launcher.test.ts`, `tests/lifecycle/claude-overlay.test.ts`, `tests/lifecycle/gateway-models-route.test.ts` | Verified `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` is child-only (parent env unchanged); every discoverable id begins with `claude`/`anthropic` (canary) and uses the `claude-rly-` namespace; the discovery flag is stripped from native settings env in the overlay (allowlist v2) so native settings cannot disable RLY discovery and plain launches never inherit it |
| AT-075 / FR-021 / SR-F-025 | `tests/unit/model-projection.test.ts`, `tests/lifecycle/gateway-models-route.test.ts` | Verified explicit reverse mapping (`resolveProjection`): a projection id resolves to one exact registry evidence target + pinned pool; routing never parses id strings; identical inputs resolve identically; unknown/removed ids fail closed |
| AT-076 / FR-021 / SR-F-025 | `tests/unit/model-projection.test.ts`, `tests/lifecycle/gateway-models-route.test.ts` | Verified `GPT-5.6 Sol (Codex)` and `GPT-5.6 Sol (ClinePass)` are distinct projections (distinct ids/labels) and each selected projection routes through the correct provider pool + account (`acct-codex-a` vs `acct-cline-a`) |
| AT-077 / FR-021 / SR-F-025 | `tests/unit/model-projection.test.ts`, `tests/lifecycle/gateway-models-route.test.ts` | Verified universe compilation from the policy: profile pool binding + single-eligible-default-pool providers only; disabled providers, multi-pool providers without an explicit binding, and providers without ready accounts are excluded; discovery lists no unreviewed/proposed/BROKEN entries |
| AT-078 / FR-021 / SR-F-025 | `tests/unit/model-projection.test.ts`, `tests/lifecycle/gateway-models-route.test.ts` | Verified VERIFIED-only default discovery; EXPERIMENTAL appears only with `gateway.modelDiscovery.experimentalModels=true`; BROKEN never appears even with the opt-in |
| AT-079 / FR-021 / SR-F-025 | `tests/lifecycle/gateway-models-route.test.ts` | Verified a session configured with Codex + ClinePass + DeepSeek discovers models from all allowed bindings without manual mapping; Codex/ClinePass/DeepSeek selections each route to their own pool; the ClinePass aggregator exposes multiple model families with correct family/provider identity |
| AT-080 / FR-021 / SR-F-025 | `tests/unit/model-projection.test.ts`, `tests/lifecycle/gateway-models-route.test.ts` | Verified session universe pinning: a policy change after session issue does not change the session's discovery and does not remap an already-issued projection id; a model removed from the registry fails closed instead of substituting |
| AT-081 / FR-021 / SR-F-025 | `tests/lifecycle/gateway-models-route.test.ts`, `tests/unit/model-projection.test.ts` | Verified unknown projection ids and removed/ineligible targets return an actionable typed `model-unavailable` error (or `capability-rejected` with the typed reason) with no silent model/provider substitution |
| AT-082 / FR-021 / SR-F-025 | `tests/lifecycle/gateway-models-route.test.ts` | Verified exact projected selection passes #68 exact selection (trace `source=exact`) and #70 reasoning translation (thinking request → `BALANCED`/`normalized`); route traces carry allowlisted projection id/display metadata + exact model/account decisions and no secrets |
| AT-083 / FR-021 / SR-F-025 | `tests/lifecycle/claude-overlay.test.ts`, `tests/lifecycle/gateway-models-route.test.ts` | Verified RLY-only projection persistence stays inside the overlay (AT-069 base), the discovery flag is child-env only, and concurrent sessions have no global `model` write-back (overlay #74 contract unchanged); discovery/trace bodies secret-free |

## Maintenance rule

When a requirement changes, update its owning document and this matrix in the same change. When implementation completes, add the executable evidence reference without replacing the stable acceptance ID. If a Must requirement lacks downstream coverage or current evidence, the phase/release cannot be marked accepted.

## Current baseline status

- BR-001/006/008 have partial verified evidence from the completed Claude direct-provider milestone.
- Control-plane foundation evidence exists for schema/migrations, authenticated management, CLI administration, and secret-free DTOs.
- Credential broker and Codex OAuth evidence exists for import, login, refresh CAS, revoke, recovery, and a request-scoped Anthropic route. Request-time pool selection, Claude Code profile integration, and the secret-free local UI are implemented; `rly <profile>` is the canonical Claude Code alias and Codex CLI remains `rly run codex`.
- The model intelligence registry (`src/registry/model-registry.ts`) is the canonical model-data layer and the source of truth for #68-#72: exact access-provider identity, upstream model id/family, capability/limits/reasoning evidence, typed compatibility state, deterministic query helpers, and a discovery→proposal boundary that never mutates reviewed evidence (#23). `ProviderRecord.capabilityEvidence` is typed against the registry schema (was `unknown`).
- The macOS LaunchAgent adapter is delivered by #33 on top of the #65 service-manager contract: one per-user `com.rly.gateway` plist without root, launchctl v2/legacy tolerance, idempotent repair that unloads before reloading, bounded crash-restart, secret-free paths, and service load state/pid reported separately from runtime readiness (AT-036). Linux `systemd --user` specifics remain #34.
- The capability based model selection engine (#68) runs deterministically before account selection: trusted-registry candidates pass hard eligibility (exact evidence, protocol capabilities, reasoning semantics, compatibility state) then rank in stable document order; the selected physical model is frozen into the effective request/route and `RouteSelector` keeps owning account/credential choice within one pool (AT-044–AT-047).
- The provider-neutral reasoning intelligence layer (#70) preserves Claude Code's requested reasoning intent (canonical `OFF`/`ECONOMY`/`BALANCED`/`DEEP`/`MAXIMUM`/`AUTO` plus source mode/effort fidelity) and translates it deterministically per selected model through a provider-owned boundary (`resolveReasoning`) into the exact native control using registry `ReasoningCapabilityEvidence` (discrete effort, binary, adaptive, token-budget, unsupported). Every non-exact mapping is recorded (mapping kind + fallback reason) and explicit unsupported intents fail closed; the OpenRouter adapter no longer collapses `enabled`/`adaptive` into one boolean (AT-053–AT-056).
- The provider/family-scoped model tier resolver (#69) makes portable tier aliases (`haiku`/`sonnet`/`opus`/`fable`) resolve deterministically inside the current execution context (access provider → parent model family → trusted capability evidence) with a frozen reviewed tier mapping, per-profile user overrides, explicit fallback scopes only, and secret-free traces; `model: fable` on a ClinePass profile resolves to the verified same-family target and feeds #68/#70/the account selector (AT-057–AT-064).

- The `rly config` user control plane (#66) is the primary post-install surface on top of the #65 resident runtime: durable `~/.rly` configuration resolution (no CWD `gateway.config.toml` on the normal installed path), resident-runtime ensure/recover, secret-free status, local loopback UI bootstrap through the existing fragment session, and focused provider/account/pool/profile shortcuts over the same management endpoints and policy revision as `rly admin` (AT-048–AT-052).
- The RLY Claude configuration overlay (#74) replaces the throwaway `CLAUDE_CONFIG_DIR` temp directory with a durable RLY-owned namespace under the RLY home: native Claude config stays read/compose-only input through a typed allowlist, RLY-only gateway/model state persists only inside the overlay, RLY session/history state survives launches, concurrent RLY sessions are race-safe, and the no-global-Claude-config-mutation rule is retained (AT-065–AT-072; FR-020; SR-F-024).
- The gateway model discovery/projection layer (#72) exposes the configured, trusted RLY model universe to Claude Code through authenticated `GET /v1/models` on the gateway listener with the supported discovery wire contract; projections use the Claude-compatible `claude-rly-*` namespace with an explicit reverse mapping to one exact access-provider/model target + pinned pool; sessions pin their universe (policy/registry revision + bindings) at issue time; `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` is child-only; exact projected selections pass #68/#70 and route through the pinned pool's account selector, failing closed on unknown/removed/ineligible targets (AT-073–AT-083; FR-021; SR-F-025).

- The macOS LaunchAgent adapter is delivered by #33 on top of the #65 service-manager contract: one per-user `com.rly.gateway` plist without root, launchctl v2/legacy tolerance, idempotent repair that unloads before reloading, bounded crash-restart, secret-free paths, and service load state/pid reported separately from runtime readiness (AT-036). The Linux `systemd --user` adapter is delivered by #34 on the same contract: one per-user `rly-gateway.service` without root, user-manager bus probe with actionable no-linger guidance, change-only `daemon-reload` with idempotent repair, bounded `StartLimit` restart policy, secret-free unit with durable `~/.rly` paths, and unit enabled/active/process state reported separately from runtime readiness (AT-040).
- Exact evidence mapping is completed phase by phase; no pending row is represented as passing.

## Phase 23 executable evidence (propose-only catalog refresh, #23 / BL-042)

| Acceptance | Evidence | Status |
| --- | --- | --- |
| AT-038 | `tests/unit/catalog-proposal.test.ts`, `tests/contract/providers/catalog-discovery.test.ts`, `tests/unit/proposal-store.test.ts`, `tests/unit/cli-admin.test.ts` | Verified deterministic drift engine (`proposeCatalogDrift`) with stable empty proposal on identical inputs; per-kind drift entries (new/removed/family/reasoning/limits/declared capability); cross-provider upstream-id separation; 250-model aggregator snapshot stays deterministic and activates nothing; fail-closed on mixed-provider and duplicate snapshots; OpenRouter API discovery (GET /models) with explicit normalization rules and optional env-ref auth; static reviewed-path source; schema-validated artifact persistence separate from trusted evidence; `rly admin models refresh|proposals` surfaces proposals with `trusted: false` and never mutates `directProviderRegistry` |
| AT-039 | `tests/contract/providers/catalog-discovery.test.ts`, `tests/unit/proposal-store.test.ts`, `tests/unit/catalog-proposal.test.ts` | Verified privacy-redacted upstream errors (bearer tokens / credential pairs / email stripped), secret-free report/artifact walks, and fail-closed reads of malformed artifacts |
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
