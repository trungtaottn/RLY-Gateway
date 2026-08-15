# RLY Gateway Product Specification

| Attribute | Value |
| --- | --- |
| Document | Build-ready product and system specification |
| Version | 0.2 |
| Baseline date | 2026-08-13 |
| Status | Approved control-plane baseline |
| Product | RLY Gateway |
| Coding harness | Claude Code CLI |
| Profile alias | `rly <profile>` launches Claude Code |
| Codex CLI | `rly run codex` escape hatch only |
| Delivery posture | Private-first, public-ready |

## 1. Purpose

RLY Gateway is a local subscription orchestration fabric. Claude Code is the single coding-harness UX: `rly <profile>` launches Claude Code with that RLY profile. Provider names are not harnesses. The product owns a local control plane for provider accounts, credentials, profiles, pools, health, and routing policy while preserving client protocol semantics instead of flattening every request into generic chat completions.

## 2. Product outcome

The completed protocol milestone runs Claude Code through a local gateway with correct Anthropic Messages behavior and verified direct-provider routing. The next milestone adds a self-owned credential broker and deterministic account control plane, beginning with Codex OAuth accounts used through Claude Code. Codex CLI remains an explicit `rly run codex` escape hatch through an OpenAI Responses boundary; it is not a parallel product UX.

## 3. Users and operating context

- Initial user: repository owner on a personal macOS workstation.
- Deployment: per-user resident loopback service in V1, with a foreground loopback fallback when no service is initialized. `rly init` installs the resident runtime; `rly <profile>` reuses it.
- Usage: interactive coding-agent sessions, including tools, reasoning, images, streaming, and cancellation.
- Maintenance: frequent provider/model/CLI updates with fixture-first compatibility work.

## 4. Harness scope

Claude Code is the single coding harness. A profile name is the user-facing alias: `rly codex`, `rly clinepass`, and `rly deepseek` each launch Claude Code with that RLY profile. `rly run claude --profile <name>` remains compatibility. `rly run codex` launches Codex CLI and is not a provider alias. Do not add a separate Alias type.

### 4.1 Claude Code — canonical harness

Required behavior:

- Anthropic `POST /v1/messages`, streaming and non-streaming, after the
  protocol boundary is connected to an enabled provider route.
- `POST /v1/messages/count_tokens` with declared accuracy quality, after the
  route's provider behavior is verified.
- Text, images, tool use, tool results, tool choice, thinking, and redacted thinking.
- Incremental text, reasoning, and tool-argument deltas.
- Usage and stop-reason fidelity.
- Cancellation, backpressure, structured errors, and safe retry boundaries.
- Explicit `primary`, `fast`, and `reasoning` model roles.
- Authenticated `GET /v1/models` gateway model discovery on the gateway listener: RLY-launched Claude sessions (child-only `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`) discover the configured, trusted RLY model universe through the supported Claude Code wire contract; every discoverable id uses the Claude-compatible `claude-rly-...` namespace and maps through an explicit reverse mapping to one exact access-provider/model target and provider pool.
- Child-only gateway environment over durable profile-scoped RLY Claude configuration views (`~/.rly/claude/views/<view-id>`): the user's native Claude settings/agents/skills/plugins are composed as read-only input, RLY session/model state persists inside the owning profile view (an RLY-only `claude-rly-*` model chosen via `/model` never poisons a plain `claude` launch or another RLY profile), and global Claude configuration remains unchanged.

### 4.2 Codex CLI — `rly run codex` escape hatch

Required for the explicit Codex CLI launch path, not as a peer coding UX:

- OpenAI Responses request/item/event lifecycle.
- Streaming, function-call argument deltas, reasoning, usage, errors, and cancellation.
- Transient launch configuration; global Codex configuration remains unchanged.
- Fake-upstream E2E before subscription bridge integration.

## 5. Backend scope

| Backend | Type | Delivery order |
| --- | --- | --- |
| OpenRouter API | Direct API | First Claude route |
| DeepSeek API | Direct API | Second Claude route |
| OpenAI/Codex subscription | Project-owned OAuth or attested bridge | First control-plane vertical slice |
| Claude subscription | Project-owned OAuth or attested bridge | After credential broker and pool engine |
| Google Antigravity | Project-owned OAuth or attested bridge | Provider expansion |
| Google Gemini / Code Assist | Project-owned OAuth | Provider expansion |
| ClinePass | Explicit interoperability adapter | Provider expansion |
| OpenCode Go | Direct coding-plan API | Provider expansion |
| Alibaba Token Plan | Direct or OAuth adapter | Local-only, terms-gated provider expansion |

Additional providers remain outside V1 until promoted through the provider contract and provenance gates.

## 6. Functional requirements

### 6.1 Routing

- Route selection is explicit by provider/model or approved model role.
- Route and capability snapshot are immutable for one request.
- Required unsupported semantics are rejected before upstream invocation.
- Model capability selection (#68) is a deterministic stage before account selection: it picks one eligible physical model from the trusted model intelligence registry (capabilities, reasoning, compatibility) and freezes it into the effective request/route; the pool selector then chooses the account/credential without changing the model.
- Claude Code subagent requests (#71): the gateway captures Claude Code agent attribution headers as typed runtime context, resolves a subagent's portable model tier inside its parent agent's execution context (exact parent → session main → unambiguous launch-session default), and routes through the same #69 → #68 → #70 → account-pool stages while the parent/main session stays on its model; undeterminable families and unsatisfied capabilities fail closed with actionable causes. RLY never inspects prompts, never runs a workflow engine, and has no global subagent model override.

- Gateway model discovery (#72) is a presentation + exact-target selection surface: `GET /v1/models` projects only trusted models from enabled configured provider→pool bindings with stable `claude-rly-...` ids; an explicit reverse mapping resolves each id to one exact access-provider/model target and pinned pool (never by parsing id strings), and the selected target then runs the same #68/#70/account pipeline. A session pins its universe (policy/registry revision + bindings) at launch so policy drift never silently remaps an issued id; unknown/removed/BROKEN targets fail closed.
- No prompt-derived routing or silent provider substitution.

### 6.2 Provider adapters

- Direct adapters resolve approved credential references at request time.
- Each model has evidence-dated capabilities and token-count quality.
- The model intelligence registry (`src/registry/model-registry.ts`) is the canonical evidence source for provider/model identity, capability, limits, reasoning controls, and compatibility state (#67); discovery proposes, it never silently rewrites reviewed evidence (#23). `rly admin models refresh` queries or imports a provider catalogue, normalizes it into candidate evidence, diffs it against reviewed evidence, and emits/persists a deterministic propose-only drift report; it never activates or mutates trusted evidence, and promotion requires a separate reviewed control-plane operation (#69/#72).
- Provider-specific behavior remains in its adapter even when transport is OpenAI-compatible.
- Runtime probes never silently rewrite the committed registry.

### 6.3 Credentials and accounts

- Credential broker owns project-managed import, login, refresh, generation, locking, atomic persistence, and recovery.
- Secret records live in a project-owned `0700` directory with `0600` files or an approved OS secret backend; SQLite stores metadata and handles only.
- Import from another client store is explicit and read-only by default. Continuous interoperability is provider-specific, opt-in, schema-pinned, locked, backed up, and recovery-tested.
- Account metadata is distinct from credential material and records ownership, provider, state, pause reason, terms acknowledgement, health, and credential generation.
- Refresh is single-flight per credential and commits through compare-and-swap generation so stale refreshes cannot overwrite newer credentials.

### 6.4 Pools and request-time routing

- Eligibility filtering precedes account selection. Paused, expired, authentication-unready, cooling, capability-incompatible, or terms-unaccepted accounts are ineligible. Quota-exhausted accounts are ineligible only while cooling; after cooldown they are recovery probes. Success restores healthy; probe failure extends cooldown.
- Initial selection supports manual pinning, `round-robin`, and `fill-first`; quota-aware selection follows only with evidence-backed quota state.
- One request binds one account pseudonym and credential generation in an immutable `EffectiveRoute`.
- Retry or account rotation is allowed only before the first response byte or tool event and within a bounded, auditable budget.
- Control plane publishes versioned policy/configuration. The data plane creates `EffectiveRoute` only after deriving request capabilities and selecting an eligible account.

### 6.5 Managed bridges

- A bridge may own OAuth, refresh, account state, installation, and lifecycle when selected instead of a project-owned provider adapter.
- Gateway checks configured identity, protocol, version, and capabilities.
- Readiness distinguishes reachable, authenticated, and model usable.
- Wrong identity or breaking version fails closed.
- V1 supports loopback bridges only.

### 6.6 Control plane and management

- Local admin API owns provider, account, profile, pool, health, policy, and metadata-only audit mutations.
- Management and data APIs have separate router/listener boundaries even if one process hosts both.
- Data defaults to `127.0.0.1:17871`; management defaults to `127.0.0.1:17872`. Both use the existing read-only collision preflight and instance attestation; a foreign listener fails closed and is never signaled or bypassed with another port.
- CLI management uses a separate per-instance bearer secret from a restrictive runtime record. Browser management starts only from a launcher-issued, single-use, short-lived fragment token exchanged for an `HttpOnly`, `SameSite=Strict` session cookie; the fragment is removed from browser history after exchange.
- Management requires exact loopback Origin validation, CSRF protection on mutations, versioned mutations, bounded sessions, explicit logout, and migration rollback. The management listener stops with the attested gateway instance.
- Management DTOs never expose secret values, raw account identity, prompts, responses, or authorization material.
- UI follows the tested management contract; it never reads credential files directly.
- `rly config` is the primary post-install user control plane: it resolves durable configuration from the `~/.rly` installation record (no CWD `gateway.config.toml` on the normal installed path), ensures/reuses the resident runtime, and operates providers/accounts/pools/profiles/credentials through the same management endpoints and policy revision as `rly admin`.

### 6.7 Launcher and lifecycle

- Deterministic default endpoint `127.0.0.1:17871` after collision preflight.
- A transient gateway token authenticates local requests.
- Ownership evidence includes process start identity, instance identity, config fingerprint, and leases.
- Compatible concurrent sessions may reuse an attested instance.
- `rly init` registers the per-user resident service (macOS LaunchAgent or Linux `systemd --user`) and starts it; the resident runtime owns a service lease renewed by its own process so the zero-lease idle shutdown never fires while the service is intentional.
- `rly <profile>` and diagnostics reuse the same attested resident runtime; closing a Claude/Codex child releases only its launch/session lease and never stops the resident service.
- RLY-launched Claude sessions point `CLAUDE_CONFIG_DIR` at the durable RLY Claude configuration overlay (composed from native user config through a typed allowlist; see FR-020/SR-F-024); RLY-only gateway/model state lives only in the overlay and a later plain `claude` launch is unaffected. Codex keeps its throwaway `CODEX_HOME` isolation.
- Explicit service stop revokes launch sessions and closes boundedly through the existing shutdown safety logic; a foreign or unattested listener is never signaled.
- Safe zero-downtime runtime update (#73/#92/#93): `rly update` separates candidate installation from activation through durable secret-free states; installed deployments are immutable and content-addressed under `<control-plane>/runtime/versions/<artifactId>` (SHA-256 over the exact candidate bytes; semantic version is metadata only) with explicit `staged`/`active`/`previous` references under `runtime/refs/` — installation updates only `staged` and never changes the serving `active` reference, and reference replacement is atomic (temp-create + rename + parent fsync) so readers always observe a valid old or new reference; legacy `runtime/current`/`previous` + `versions/<semver>` layouts migrate in place without deleting a serving known-good runtime; the serving runtime's `/identity` reports its actual runtime version, state/schema version, update state and transaction phase, active launch-session count, and drain flag through the attested handshake; **activation is a durable transaction (#93)** journaled STAGED → DRAINING → SWITCHING → PROBATION → COMMITTING → COMMITTED (or ROLLING_BACK → COMMITTED | RECOVERY_REQUIRED) with each phase durably written before the action it fences; existing Claude sessions keep running on the old process until a safe zero-session drain point (launch-session count, not TCP) unless the user explicitly requests the destructive `--force` path; the new-launch fence is established before the serving ref switch, activation restarts only attested resident runtimes through the per-user service manager (#33/#34 `restart()`) and refuses new launch-session issuance once draining begins; new launches while activation is pending follow the documented compatibility policy (compatible pairs continue on the old runtime; incompatible pairs refuse only new launches with an actionable `update-pending`/`runtime-version-mismatch` message); the candidate is accepted during probation only after exact identity/protocol/readiness/state-open verification and rolls back at most once to the previous known-good version on failure (verified, reported, never looped); migration rollback safety uses compatibility classes (`none`/`backward-compatible-expand`/`transactional-replace`/`forward-only`) and forward-only migrations block activation before any destructive state change; rollback failure terminates in the explicit `recovery-required` state with an actionable `rly doctor` path; concurrent updates serialize through an ownership-aware stale-reclaimable lock that records the real OS process-start identity; crash/reboot states recover deterministically from the durable journal phase and never guess a candidate committed; foreign/unattested port owners after restart fail closed and are never signaled; `status`/`doctor` expose allowlisted version/update metadata. Candidate distribution/signing stays #35 (BACKLOG); the lifecycle is independent of the distribution channel.
- Foreign listeners are never killed and do not cause port auto-increment.
- Signals and cancellation propagate to active upstream work.

### 6.8 Diagnostics

Allowed by default:

- request ID;
- provider/model/route identifiers;
- capability and readiness states;
- version, timing, and status metadata.

Forbidden by default:

- prompts or responses;
- raw credentials or authorization headers;
- email or account identity;
- captured real provider payloads.

### 6.9 Runtime compatibility canary (#24)

- RLY detects the exact installed Claude Code / Codex CLI version separately from binary `found` state (version parsed from the client's own `--version` output; never inferred from timestamps or paths; unknown when unparseable). Binary presence is never compatibility, and a newly installed unknown client version surfaces a visible `unknown/not-tested` status without silently replacing the tested baseline.
- The canary pins the supported client baseline's wire contract with redacted fixtures (Claude Code session/agent/parent attribution headers; gateway `GET /v1/models` request/auth/response selection incl. the discovered-id prefix rule and startup cache; `fable`/`haiku`/`sonnet`/`opus` alias semantics; subagent/session `effort`; streaming framing; `--no-session-persistence`) and runs a deterministic fake gate matrix per exact access path (text, streaming, cancellation, single/multi/parallel tools, reasoning, reasoning+tools, model discovery, session attribution, subagent routing, parallel subagents, effort signal, long-running session).
- Each exact access path is classified `EXPERIMENTAL` (a full deterministic Layer A pass — production trust requires Layer B/C evidence plus reviewed promotion, #124; `livePassed`/`liveEvidence` are removed, so no observation can be `VERIFIED`), `BROKEN` (a required contract fails), or `unknown` (required gates unrun, never reported as passed). Evidence is keyed by exact client kind/version + access provider + adapter + physical model; the same upstream model through two access providers never shares evidence.
- `rly canary run|status` emits secret-free, machine-readable evidence artifacts under `<control-plane>/canary/` consumable by #23/#67 review tooling and appends versioned, feature-scoped Compatibility Claim + Evidence v2 documents under `<control-plane>/claims/` (see §6.10); the canary reports evidence and drift and never mutates trusted registry evidence, tier mappings, or `/v1/models` projection. The #72 projection gate consumes canary-derived compatibility state (`VERIFIED` default, `EXPERIMENTAL` opt-in, `BROKEN`/unreviewed never). Live provider runs remain opt-in (`RLY_LIVE_CANARY=1`, skipped ≠ pass) — the switch only enables execution and can never create evidence.

### 6.10 Compatibility Claim and Evidence v2 (#122)

- RLY maintains a versioned, feature-scoped Compatibility Claim + Evidence model (`src/canary/claim.ts`) keyed to the exact execution path: client kind, exact client version/baseline, source protocol/revision (#119 vocabulary), adapter/integration surface, access provider, auth mode, endpoint contract, exact physical model, and feature/capability claim. Model family is classification metadata only and never part of the key. Same upstream model through two providers, and two features on the same path, produce distinct claim keys/documents/evidence histories — no cross-provider/model/feature reuse.
- Features (text, streaming, cancellation, tools incl. parallel/multi-tool continuation, reasoning, reasoning+tools, model discovery, session/subagent attribution, config-overlay behavior, and other relied-on features) are claimed independently; passing text never implies tool/reasoning/discovery compatibility.
- Evidence layers are explicit: Layer A = deterministic protocol/adapter conformance with fake/synthetic fixtures (the current canary matrix is reclassified as Layer A); Layer B = exact installed-client black-box behavior; Layer C = exact real access-path live verification. Layer B/C runners are owned by #123 (not built here); required layers are declared per adapter (`requiredLayersForAdapter`; unknown adapters fail closed) and layer presence/result is never collapsed into one boolean.
- No boolean can grant production trust: `livePassed`/`liveEvidence` are removed from the authoritative classification path; classification can never emit `VERIFIED` from an observation. `RLY_LIVE_CANARY`/`liveRunnerEnabled` may enable a runner hook (#123) but can never stand in for an evidence artifact. Missing/skipped/unrun evidence is distinct from PASS and FAIL (`missing`/`not-run`); a deterministic Layer A pass never implies live/production trust. Promotion of a satisfied claim to trusted registry state is #124 (out of scope here); registry `CompatibilityEvidence.claimRef` (revision 5) links reviewed state to its exact claim key.
- Claim/evidence documents are versioned (`schemaVersion` 1 / `evidenceSchemaVersion` 2) and persist append/audit-friendly under `<control-plane>/claims/` with deterministic lookup by exact claim identity + feature; identical observations are deduped and malformed documents fail closed. Legacy v1 canary outputs are flagged legacy/untrusted (`legacy-v1-artifact-untrusted-for-v2-claims`) and can never silently satisfy a stronger v2 claim. Evidence artifacts never contain credentials, auth headers, account identity, prompts, real responses, or reasoning text.

## 7. Quality attributes

- Correctness: byte/event-order golden contracts for supported client protocols.
- Isolation: concurrent requests cannot share mutable route state.
- Safety: no retry after response first byte or tool event.
- Privacy: secret and payload redaction is a release gate.
- Recoverability: native client path remains available because global config is not persisted.
- Maintainability: provider changes require fixtures, capability evidence, and compatibility-document updates.

## 8. V1 non-goals

- Remote or multi-user control plane.
- System-wide/root daemon shared by multiple OS users.
- Weighted, cost, prompt-derived, or unbounded automatic-failover routing.
- Generic provider/plugin marketplace.
- Silent credential discovery or import.
- Persistent global Claude/Codex configuration (RLY Claude configuration state lives only in the RLY-owned overlay under `~/.rly`; native Claude config is never rewritten).
- Prompt-derived routing.
- Hot reload within an active request.

## 9. Acceptance criteria

### Claude MVP

- Real Claude Code completes text and tool round trips against fake upstream.
- Helper role selects the configured route without contaminating another request.
- Ctrl-C aborts upstream work and cleans project-owned processes.
- Two concurrent sessions pass lifecycle and route-isolation tests.
- One direct provider passes opt-in text, stream, tool, usage/stop, and token-count smoke.
- Global Claude configuration fingerprint is unchanged by controlled E2E.
- Existing protected processes/ports are unchanged.
- Offline protocol, lifecycle, privacy, lint, typecheck, and build gates pass.

### Canary gate (BL-043 / #24)

- Claude Code and Codex target detection reports exact installed version metadata separately from `found`; a newly installed unknown version surfaces `unknown/not-tested` and never silently replaces the tested baseline.
- The supported baseline's wire contract is pinned with redacted fixtures (attribution headers, `/v1/models` discovery incl. id-prefix filter and startup cache, tier aliases incl. `fable`, subagent/session `effort`, streaming framing) and the deterministic fake matrix covers text, streaming, cancellation, tools, reasoning, reasoning+tools, model discovery, subagent routing, parallel subagents, effort signal, and long-running sessions; a deliberately changed fixture fails the exact gate with a typed reason.
- Compatibility evidence is keyed by exact client version + access provider + adapter + physical model with no cross-provider reuse; `VERIFIED` is unreachable from any observation (#122 — `livePassed`/`liveEvidence` are removed) and `EXPERIMENTAL`/`BROKEN`/`unknown` semantics are typed with missing/unrun evidence never reported as passed; the deterministic matrix is reclassified as Layer A Evidence v2 and the #72 projection gate consumes canary-derived state (VERIFIED default, EXPERIMENTAL opt-in, BROKEN never); `rly canary run|status` emits secret-free artifacts and appends feature-scoped claim/evidence v2 documents without mutating trusted registry evidence; live provider runs stay opt-in and `skipped ≠ pass`.

### V1

- Project-owned Codex OAuth credentials pass import/login/refresh/expiry/concurrency/recovery gates.
- OAuth callback tests cover PKCE verifier/challenge, exact redirect address, state mismatch/replay/expiry, callback port collision, bounded error bodies, and cancellation.
- Logout/revoke removes active, temporary, and backup secret records after upstream revocation where supported; verification proves no project-owned usable credential remains. Filesystem deletion is not claimed as forensic media erasure.
- Manual account selection, pause, eligibility, deterministic pool routing, cooldown, and bounded pre-stream rotation pass race/crash tests.
- Management API never returns secrets and rejects unauthenticated, cross-origin, stale-version, and invalid-CSRF mutations.
- Codex CLI passes Responses fake-upstream E2E.
- Every enabled adapter passes its declared contract and opt-in smoke.
- Bridge mismatch and auth-expiry tests fail safely.
- Clean install/package, provenance, dependency-license, and privacy gates pass.

## 10. Sources and precedence

1. Explicit owner decisions.
2. This `SPEC.md` product contract.
3. Accepted ADRs and `docs/ARCHITECTURE.md`.
4. Active plan phase files for execution detail.
5. Research reports and upstream sources as evidence, not authority.

When sources conflict, do not silently reinterpret scope; update the owning authority explicitly.

## Unresolved questions

- First provider adapter is project-owned Codex OAuth; additional providers choose project-owned OAuth, explicit interoperability, direct API, or attested bridge from evidence and owner decision.
- Initial local UI scope follows the management contract and does not block credential broker or pool acceptance.
- Live model-role mappings depend on current catalogs and owner preference.
