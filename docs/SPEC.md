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
- Incremental streaming transport (#120): each canonical event encoded exactly once with bounded per-stream state (no full-history re-encode); downstream backpressure pauses upstream iteration; client disconnect aborts upstream work with no frames after close; a setup (first-frame) timeout is separate from an idle/progress timeout between frames — no generic whole-request timer, so healthy long agent streams survive; stream resources terminate exactly once on every terminal path.
- Cancellation, backpressure, structured errors, and safe retry boundaries.
- Explicit `primary`, `fast`, and `reasoning` model roles.
- Authenticated `GET /v1/models` gateway model discovery on the gateway listener: RLY-launched Claude sessions (child-only `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`) discover the configured, trusted RLY model universe through the supported Claude Code wire contract; every discoverable id uses the Claude-compatible `claude-rly-...` namespace and maps through an explicit reverse mapping to one exact access-provider/model target and provider pool.
- Child-only gateway environment over durable profile-scoped RLY Claude configuration views (`~/.rly/claude/views/<view-id>`): the user's native Claude settings/agents/skills/plugins are composed as read-only input, RLY session/model state persists inside the owning profile view (an RLY-only `claude-rly-*` model chosen via `/model` never poisons a plain `claude` launch or another RLY profile), and global Claude configuration remains unchanged.

### 4.2 Codex CLI — `rly run codex` escape hatch

Required for the explicit Codex CLI launch path, not as a peer coding UX:

- OpenAI Responses request/item/event lifecycle.
- Streaming, function-call argument deltas, reasoning, usage, errors, and cancellation, executed through the same incremental transport (#120) as the Anthropic Messages path.
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
- Model capability selection (#68) is a deterministic stage before account selection: it picks one eligible physical model from the trusted model intelligence registry (capabilities, reasoning, compatibility) and freezes it into the effective request/route; the pool selector then chooses the account/credential without changing the model. Since #124 the compatibility dimension is resolved by the Effective Compatibility Registry (reviewed promotion + quarantine + freshness + enforcement), not by the static registry state alone. Since #127 the FINAL model-control output before account selection is ONE typed, secret-free `EffectiveModelDecision` per routing request: it assembles the typed selector intent/provenance (#125), the frozen physical provider/model/family target + provenance (#68/#69/#71/#72), the reasoning mapping (#70), the ECR compatibility reference (#124), the provider→pool binding, policy/profile/session/registry/mapping revisions, #126 view/env-settings ownership state, visible deterministic conflicts, blocked alternatives, and stable reasons — with no account/credential identity (account selection stays downstream in the pool).
- Claude Code subagent requests (#71): the gateway captures Claude Code agent attribution headers as typed runtime context, resolves a subagent's portable model tier inside its parent agent's execution context (exact parent → session main → unambiguous launch-session default), and routes through the same #69 → #68 → #70 → account-pool stages while the parent/main session stays on its model; undeterminable families and unsatisfied capabilities fail closed with actionable causes. RLY never inspects prompts, never runs a workflow engine, and has no global subagent model override.

- Gateway model discovery (#72) is a presentation + exact-target selection surface: `GET /v1/models` projects only trusted models from enabled configured provider→pool bindings with stable `claude-rly-...` ids; an explicit reverse mapping resolves each id to one exact access-provider/model target and pinned pool (never by parsing id strings), and the selected target then runs the same #68/#70/account pipeline. A session pins its universe (policy/registry revision + bindings) at launch so policy drift never silently remaps an issued id; unknown/removed/BROKEN targets fail closed.
- No prompt-derived routing or silent provider substitution.

### 6.2 Provider adapters

- Direct adapters resolve approved credential references at request time.
- Each model has evidence-dated capabilities and token-count quality.
- The model intelligence registry (`src/registry/model-registry.ts`) is the canonical evidence source for provider/model identity, capability, limits, reasoning controls, and compatibility state (#67); discovery proposes, it never silently rewrites reviewed evidence (#23). `rly admin models refresh` queries or imports a provider catalogue, normalizes it into candidate evidence, diffs it against reviewed evidence, and emits/persists a deterministic propose-only drift report; it never activates or mutates trusted evidence, and promotion requires a separate reviewed control-plane operation (#69/#72).
- Provider-specific behavior remains in its adapter even when transport is OpenAI-compatible.
- Runtime probes never silently rewrite the committed registry.
- Since #121: same-protocol OpenAI Responses requests use a TRUE native Responses upstream rail whenever the adapter declares the exact Responses endpoint contract (`POST {endpoint}/responses` — OpenRouter direct today). The rail preserves Responses item identity, continuation fields, tool/reasoning item ordering, and #119 opaque artifacts through provider invocation. `OpenAI-compatible` is NOT a sufficient compatibility class: every claimed Responses path identifies its exact endpoint/adapter contract. Provider failures carry safe structured metadata (status/code/type/message/param/retry-after/rate-limit) through `ProviderAdapterError.info`; both routes translate it onto protocol-correct client errors and surface `retry-after`, so generic normalization is the fallback, never the only path.

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
- Since #121: rotation additionally requires an explicit provider commitment state of `not-sent` — the policy must prove the previous attempt never crossed a provider/client/tool commitment boundary. A deterministic 4xx rejection is rotation-safe; a 5xx or post-send network failure is `unknown` (conservative no-replay); failure after provider acceptance, during streaming, or at a tool boundary never rotates or replays. Account failover never changes the frozen physical model (#127).
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
- `rly init` registers the per-user resident service (macOS LaunchAgent or Linux `systemd --user`) and starts it; the resident runtime owns a service lease renewed by its own process so the zero-lease idle shutdown never fires while the service is intentional. Since #94 the registered definition references ONE stable RLY-owned bootstrap launcher (`<control-plane>/bootstrap/rly-gateway`) — never `dist/cli/init.js`, never a direct `runtime/refs/...` path, never the Node installation that invoked init — and `rly init` establishes the initial committed `active` deployment from the installed runtime tree (idempotent; a valid committed deployment is never rewritten). The bootstrap resolves ONLY the committed #92 `active` deployment (refusing staged/uncommitted/missing candidates) and executes the real `dist/cli/main.js` dispatcher, exporting `RLY_SERVING_ARTIFACT`.
- `rly <profile>` and diagnostics reuse the same attested resident runtime; closing a Claude/Codex child releases only its launch/session lease and never stops the resident service.
- RLY-launched Claude sessions point `CLAUDE_CONFIG_DIR` at the durable RLY Claude configuration overlay (composed from native user config through a typed allowlist; see FR-020/SR-F-024); RLY-only gateway/model state lives only in the overlay and a later plain `claude` launch is unaffected. Codex keeps its throwaway `CODEX_HOME` isolation.
- Explicit service stop revokes launch sessions and closes boundedly through the existing shutdown safety logic; a foreign or unattested listener is never signaled.
- Exact build identity (#94): a versioned identity object (`src/runtime/build-identity.ts`) binds semantic version, commit/source revision, build ID, release channel, control/data protocol versions, durable state/schema version, and the serving artifact digest; `/identity.build`, `rly --version`, doctor/status, the release-candidate manifest (`rly.json`), deployment metadata, and update probation compare the SAME fields — two artifacts sharing a semantic version are distinguishable by artifact digest, and an exact match requires every field equal. The existing attestation is extended (no parallel identity service): the ownership record fingerprint is the digest of the serving build identity (reuse fails closed on same-semantic-version-different-artifact evidence), and update probation requires the serving artifact digest to equal the candidate's immutable deployment identity whenever the serving runtime identifies its artifact.
- Service-definition reconciliation (#94): `rly init` and `rly doctor` detect missing/stale/path-drifted launchd/systemd definitions and repair them idempotently, migrating legacy definitions (Node + `dist/cli/init.js`, direct `runtime/refs/...` paths) to the bootstrap contract without provider/account reconfiguration; `rly status` reports reconciliation state read-only; a service definition never intentionally targets a staged or deleted deployment. Unsupported platforms never falsely report registration success.
- Safe zero-downtime runtime update (#73/#92/#93): `rly update` separates candidate installation from activation through durable secret-free states; installed deployments are immutable and content-addressed under `<control-plane>/runtime/versions/<artifactId>` (SHA-256 over the exact candidate bytes; semantic version is metadata only) with explicit `staged`/`active`/`previous` references under `runtime/refs/` — installation updates only `staged` and never changes the serving `active` reference, and reference replacement is atomic (temp-create + rename + parent fsync) so readers always observe a valid old or new reference; legacy `runtime/current`/`previous` + `versions/<semver>` layouts migrate in place without deleting a serving known-good runtime; the serving runtime's `/identity` reports its actual runtime version, state/schema version, update state and transaction phase, active launch-session count, and drain flag through the attested handshake; **activation is a durable transaction (#93)** journaled STAGED → DRAINING → SWITCHING → PROBATION → COMMITTING → COMMITTED (or ROLLING_BACK → COMMITTED | RECOVERY_REQUIRED) with each phase durably written before the action it fences; existing Claude sessions keep running on the old process until a safe zero-session drain point (launch-session count, not TCP) unless the user explicitly requests the destructive `--force` path; the new-launch fence is established before the serving ref switch, activation restarts only attested resident runtimes through the per-user service manager (#33/#34 `restart()`) and refuses new launch-session issuance once draining begins; new launches while activation is pending follow the documented compatibility policy (compatible pairs continue on the old runtime; incompatible pairs refuse only new launches with an actionable `update-pending`/`runtime-version-mismatch` message); the candidate is accepted during probation only after exact identity/protocol/readiness/state-open verification and rolls back at most once to the previous known-good version on failure (verified, reported, never looped); migration rollback safety uses compatibility classes (`none`/`backward-compatible-expand`/`transactional-replace`/`forward-only`) and forward-only migrations block activation before any destructive state change; rollback failure terminates in the explicit `recovery-required` state with an actionable `rly doctor` path; concurrent updates serialize through an ownership-aware stale-reclaimable lock that records the real OS process-start identity; crash/reboot states recover deterministically from the durable journal phase and never guess a candidate committed; foreign/unattested port owners after restart fail closed and are never signaled; `status`/`doctor` expose allowlisted version/update metadata. The standalone artifact channel (#35) delivers verified candidates with the SAME canonical identity; release signing/SBOM (#128) remains out of scope, and the lifecycle is independent of the distribution channel.
- Foreign listeners are never killed and do not cause port auto-increment.
- Signals and cancellation propagate to active upstream work.

### 6.8 Diagnostics

Allowed by default:

- request ID;
- provider/model/route identifiers;
- capability and readiness states;
- version, timing, and status metadata;
- stream transport metadata only (#120): event count, frame count, backpressure count, duration, and terminal kind (completed/error/cancelled/timeout with setup/idle category).

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
- Evidence layers are explicit: Layer A = deterministic protocol/adapter conformance with fake/synthetic fixtures (the current canary matrix is reclassified as Layer A); Layer B = exact installed-client black-box behavior (built by #123, §6.11); Layer C = exact real access-path live verification (built by #123, §6.11). Required layers are declared per adapter (`requiredLayersForAdapter`; unknown adapters fail closed) and layer presence/result is never collapsed into one boolean.
- No boolean can grant production trust: `livePassed`/`liveEvidence` are removed from the authoritative classification path; classification can never emit `VERIFIED` from an observation. `RLY_LIVE_CANARY`/`liveRunnerEnabled` may enable a runner hook (#123) but can never stand in for an evidence artifact. Missing/skipped/unrun evidence is distinct from PASS and FAIL (`missing`/`not-run`); a deterministic Layer A pass never implies live/production trust. Promotion of a satisfied claim to trusted registry state is #124 (out of scope here); registry `CompatibilityEvidence.claimRef` (revision 5) links reviewed state to its exact claim key.
- Claim/evidence documents are versioned (`schemaVersion` 1 / `evidenceSchemaVersion` 2) and persist append/audit-friendly under `<control-plane>/claims/` with deterministic lookup by exact claim identity + feature; identical observations are deduped and malformed documents fail closed. Legacy v1 canary outputs are flagged legacy/untrusted (`legacy-v1-artifact-untrusted-for-v2-claims`) and can never silently satisfy a stronger v2 claim. Evidence artifacts never contain credentials, auth headers, account identity, prompts, real responses, or reasoning text.

### 6.11 Installed-client (Layer B) and live access-path (Layer C) runners (#123)

- Layer B (`rly canary run-b`, `src/canary/installed-runner.ts`) runs the ACTUAL installed Claude Code / Codex CLI binary against a controlled local fixture server (client-facing Anthropic Messages + `GET /v1/models`, OpenAI Responses + `GET /v1/models`) with child-only environment isolation; records the exact executable path and probe version separately from the reviewed supported baseline (observed ≠ baseline, never auto-promoted); exercises the black-box matrix RLY relies on (request/stream framing, cancellation, tool round-trip, multi-tool continuation, parallel tools, reasoning/effort, reasoning+tools, discovery/selection, session/agent/parent attribution, tier aliases, subagent concurrency, config-overlay, long sessions); and emits per-feature Evidence v2 (layer B, `installed-client`) with runner version, fixture revision, timing, and typed/redacted failure reasons keyed to the exact observed client version — a changed client behavior is a typed gate failure for that version, and new versions are tested without becoming supported baselines (version drift surveillance). A missing/non-executable binary reports every gate `not-run` (`client-not-installed`), never PASS.
- Layer C (`rly canary run-c`, `src/canary/live-runner.ts`) executes ONE selected exact claim path (client + client version + protocol/revision + adapter + provider + auth mode + endpoint + physical model + feature gate) through the real gateway translation stack to the configured provider endpoint, ONLY with explicit opt-in (`RLY_LIVE_CANARY=1`) and an available environment credential; emits feature-scoped Evidence v2 (layer C, `live-access-path`) — text success never promotes tools/reasoning/discovery, same upstream model through two providers gets distinct keys/evidence, tool continuation is proven only when the provider returns tool calls (else `not-run`/`provider-did-not-call-tool`), and policy-driven `GET /v1/models` discovery runs on the exact-path gateway (throwaway control-plane store). Missing credentials/skipped runs/environment inability/unexecuted gates are `not-run` (or absent) — never `passed`, never `VERIFIED`; live runs never silently spend quota.
- Runners are observation-only (never mutate trusted registry/tier mappings/projection; promotion is #124) and their artifacts are secret-free: raw results under `<control-plane>/canary-runners/` (metadata only) with Evidence v2 `ref`s and additive `timingMs`; claim documents append via `ClaimEvidenceStore`. CI/manual docs separate deterministic Layer A, installed-client Layer B, and real-path Layer C execution.

### 6.12 Effective Compatibility Registry (#124)
- RLY resolves observed evidence (#122 claims / #123 Layer B/C runners), reviewed trust, health/freshness, and enforcement into ONE effective compatibility answer per exact claim/feature through the **Effective Compatibility Registry** — the SOLE runtime compatibility authority. The model registry keeps owning model identity/capability evidence and is never duplicated.
- **Review Decision Store**: explicit promote/reject decisions are tied to exact claim identities AND evidence revisions (a deterministic digest of the claim's observation history). Positive trust requires an explicit reviewed decision; a new PASS observation never auto-promotes; evidence updated after a decision makes the claim review-stale (`untrusted`, re-review required). Records persist secret-free (reviewer/source/reason/timestamp/revision only) under `<control-plane>/compat/reviews/` with append/audit-friendly monotonic revisions.
- **Negative Quarantine Store**: a strong reproducible failure can quarantine an exact claim/path/feature promptly; scope is inherently narrow (exact claim key) so one provider/model/feature failure never poisons unrelated paths; quarantine never deletes historical evidence; explicit lift is audit-friendly. Records persist under `<control-plane>/compat/quarantines/`.
- **Freshness/staleness engine**: evidence goes STALE on configured dependency changes — client version/baseline drift, protocol/adapter revision drift, provider endpoint/auth-mode drift, physical model fingerprint change, fixture/corpus revision drift, material RLY build change, and evidence age. A stale positive never stays silently VERIFIED.
- **Effective resolution**: evidence + review + quarantine + freshness + policy resolve per exact claim/feature into `trusted` / `stale` / `experimental` / `untrusted` / `quarantined` / `missing` with trust, observed health, freshness, quarantine, and enforcement reason as DISTINCT diagnosable fields — never a single persisted boolean. Precedence is deterministic: active quarantine → missing evidence → failed evidence → explicit rejection → decision no longer covering current evidence → promote + stale → promote + fresh + passed → unreviewed PASS (`experimental` at most).
- **Default enforcement**: normal execution/exposure requires effective trusted compatibility for the exact required features; quarantined/known-broken required features FAIL CLOSED with no silent fallback across provider/family/model unless an owning policy explicitly permits it. The explicit experimental override (exact-pin opt-in or `allowExperimental`) is traceable and visible in route traces/doctor and can elevate `experimental`/`stale` but NEVER `untrusted`/`missing`/`quarantined`; a hard quarantine is bypassable only through the separately documented administrative `allowQuarantineBypass` policy, and the bypass stays visible.
- **Runtime integration**: model selection (#68), logical tier resolution (#69), model projection/discovery (#72), reasoning/tool eligibility, and profile route resolution consume ECR results; static `model.compatibility.state` is no longer the final production trust authority. The gateway and `resolve-route` build the ECR snapshot from the claim/review/quarantine stores + the pinned runtime policy (client baseline, protocol/fixture revisions, material RLY build).
- **Migration/audit**: legacy static registry compatibility states become seed/reference data (`seed-reference-only`): a static `VERIFIED` row without a `claimRef` can never silently satisfy reviewed v2 trust (it derives `experimental` at best); `BROKEN` stays a hard negative seed. Auditability is preserved on trust change (monotonic revisions, append-only) and evidence expiry (freshness reasons recorded).
- **Diagnostics**: doctor/status/`rly compat` explain WHY a target is trusted, stale, quarantined, experimental, or blocked — claim identity, latest decision metadata, evidence layers, health, freshness reason, quarantine reason, enforcement reason — secret-free. Decision/quarantine records never carry credentials, account identity, prompts, responses, or reasoning text.

### 6.13 Standalone runtime artifacts (#35) — primary production distribution

- The PRIMARY production distribution is the RLY-owned standalone runtime artifact: a self-contained package per supported target that installs and runs WITHOUT a user-provisioned Node/npm/pnpm toolchain or a source checkout. GitHub Releases is the artifact origin; npm/Homebrew (if introduced) are secondary convenience channels that must consume the SAME canonical artifact lineage and never build semantically different runtime bytes under the same RLY build identity. External Node is a development concern only.
- A standalone artifact bundles the compiled runtime (`dist`), bundled runtime dependencies (prod `node_modules`, pnpm virtual-store layout preserved, metadata/`.bin`/test artifacts pruned), the exact pinned Node runtime (`bin/node`; version recorded in `rly-artifact.json` as the #128 SBOM input), licenses/notices, the release-candidate manifest (`rly.json`), the exact #94 build identity (`rly-build.json`), and artifact metadata (`rly-artifact.json`). `rly` stays the stable user-facing command; the internal layout is deterministic (`rly`, `bin/node`, `dist/`, `node_modules/`, `package.json`, `LICENSE`, `docs/third-party-notices.md`, `rly.json`, `rly-build.json`, `rly-artifact.json`) and normal execution never depends on the source repo, the pnpm workspace, a user Node, or the invoking CWD.
- The platform matrix is explicit: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` are each `supported` (built AND smoke-tested on a qualified runner) or `experimental` (built deterministically; smoke-testing requires an unprovisioned runner) with a reason; no target silently reuses another target's artifact or Node bytes.
- Package content is generated from a POSITIVE ALLOWLIST: only compiled runtime code, bundled runtime deps, required assets/templates, licenses/notices, and explicit bootstrap resources ship; `.git`, developer config, `.env`, local `~/.rly` state, dependency test artifacts, credentials, reports, private snapshots, and unrelated workspace files are excluded, and packaging FAILS on unexpected files, forbidden markers, unsafe symlinks, or secret content.
- Canonical identity: artifact production consumes the #94 exact build identity and emits semantic version, commit/source revision, build ID, release channel, target platform, bundled Node version, and the content-addressed artifact digest consistently; the canonical version authority is `RLY_RELEASE_VERSION` → exact git tag → `package.json` (resolving the `0.1.0` vs release-tag ambiguity); two byte-distinct artifacts cannot claim the same digest/identity.
- Builds are reproducible from a clean compiled tree with the frozen lockfile and pinned Node version (deterministic file lists, fixed source-date-epoch mtimes, no owner names/absolute developer paths/tokens/home dirs or pnpm store paths; identical inputs => byte-identical tarballs).
- `.github/workflows/standalone-artifacts.yml` builds + verifies the matrix on GitHub Release publication (release tag = canonical version input) or manually, smoke-tests every SUPPORTED CI target (`rly --version` from the unpacked artifact), QUALIFIES the exact artifact bytes (§6.14), and publishes the signed release supply chain (§6.14); tarballs + sha256 + manifest + signing/SBOM/provenance/channel assets are attached to the GitHub Release. Installer/updater UX (#129) remains out of scope.

### 6.14 Release supply chain (#128) — authenticity, evidence, and exact-byte qualification

RLY publishes the artifact lineage from §6.13 through a signed release supply chain. **Exact-byte qualification is the publication authority**: a release is promoted only on evidence produced by installing and exercising the EXACT artifact digest that is subsequently published — never a rebuilt equivalent, never a version label. The track owns artifact authenticity and release qualification; it does NOT own runtime activation (#92–#94) or the installer/updater UX (#129).

- **Canonical release manifest** (`rly-release.json`, `scripts/release/manifest.mjs`): one machine-readable document binds product version, release channel (beta/stable), source commit, build ID, every supported target, artifact filename/size/sha256/content-addressed digest, bundled runtime version, state/protocol compatibility, required signatures and attestations, and the workflow/toolchain inputs — consistent with the #94 exact build identity (a manifest whose identity diverges from the packaged `rly-build.json` fails publish and verification). The updater consumes this manifest; it never trusts a mutable GitHub `latest` target alone.
- **SBOM + provenance per artifact** (`rly-<target>.sbom.json`, `rly-provenance.json`; `scripts/release/sbom.mjs`, `scripts/release/provenance.mjs`): an SPDX-2.3-style SBOM is generated from the ACTUAL packaged artifact bytes (RLY components, bundled pinned Node, third-party `node_modules` packages) and references the EXACT artifact digest; provenance/attestation ties every artifact digest (tarball sha256 + content-addressed tree digest) to the exact source revision and the release workflow/toolchain inputs. Evidence is attached/referenced to the exact digest and is a SIBLING release asset — never embedded in the artifact (embedding would change the digest it describes), preserving TUF-style separation of metadata from artifacts.
- **Platform authenticity** (`platform-signing` gate in `scripts/release/qualification.mjs`): macOS production artifacts must pass the documented code-signing/notarization/stapling verification gate (codesign `--verify --deep --strict` + stapler validate on a provisioned macOS host with the Apple certificate secrets) before stable promotion; Linux authenticity uses the release artifact Ed25519 signature (`<tarball>.sig`) + the release manifest trust chain. A missing required platform signature BLOCKS promotion for that target (machine-readable).
- **Signed channel metadata** (`rly-channel-<channel>.json` + `.sig`; `scripts/release/channel.mjs`): a small signed metadata layer (Ed25519, private key ONLY as the repository secret `RLY_RELEASE_SIGNING_KEY`, public key committed at `scripts/release/signing-public-key.pem`) maps each channel to the exact release/build/artifact digests. Rollback protection is a monotonic per-channel `version` counter (a lower version than the highest observed is refused); staleness is `updatedAt` + `staleness.maxAgeDays` (stale metadata is refused); an explicit `freeze` marker blocks activation beyond the frozen snapshot. The updater must verify the signature and never trust mutable redirects.
- **Exact-byte qualification** (`rly-qualification.json`; `scripts/release/qualify.mjs`): the matrix covers clean install, `rly --version`/build identity, `rly init`/service registration, runtime readiness, update handoff contract (the #73/#92/#94 candidate contract), uninstall, permissions, and platform-specific signing checks. A gate is `passed` only when it executed against the exact bytes; `skipped`/`not-run` is never passing evidence. A target without qualification evidence is NOT stable-qualified; a missing/failed required signing, SBOM/provenance, compatibility, or platform qualification gate prevents stable promotion.
- **Release immutability** (`scripts/release/immutability.mjs`): published stable bytes/digests are never silently replaced under the same release/build identity — re-publishing the same version with different digests fails, and verification detects any byte replacement of published assets (actual bytes vs signed metadata). If GitHub release mutability cannot be disabled, the signed metadata + build identity make replacement detectable and unacceptable.
- **Workflow hardening**: release-critical third-party GitHub Actions are pinned to reviewed immutable commit SHAs (enforced by `scripts/check-release-supply-chain.mjs`, part of the release gate); release workflows use least-required `GITHUB_TOKEN`/release permissions and never configure npm credentials (npm is not the primary channel).
- **Beta vs stable gates** (machine-readable): beta may permit documented experimental qualification gaps (recorded in the qualification document and channel metadata as `experimental-gaps`); stable requires `qualified` status for every advertised target plus all authenticity/compatibility/privacy/Wave-4-integration gates. Beta evidence can never masquerade as stable qualification.
- **Privacy/public boundary**: release manifests, SBOMs, provenance, channel metadata, signatures, and qualification records contain public build metadata only — no credentials, tokens, local state, private source-history content, prompts, responses, or account identity. The signing private key never enters the repository.

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
- Requiring users to install pnpm or a matching Node 24 runtime for normal use: standalone RLY-owned runtime artifacts bundle the exact pinned Node runtime and are the PRIMARY production distribution; external Node is a development concern only (dev checkout still uses Node 24 + pnpm 11.16).
- Windows support unless separately promoted.
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
- The Effective Compatibility Registry (#124) is the sole runtime compatibility authority: explicit reviewed promotion (never PASS alone), negative quarantine of exact claims (narrow scope, never deleting evidence), freshness/staleness over client baseline/protocol-adapter revision/provider auth-mode/model fingerprint/fixture revision/material RLY build changes, and one effective answer per exact claim/feature with trust/health/freshness/quarantine/enforcement kept distinct; required features fail closed by default, the experimental override is explicit and traceable and can never bypass a hard quarantine, legacy static registry states are seed/reference data that can never silently satisfy reviewed v2 trust, and doctor/`rly compat` explain why a target is trusted/stale/quarantined/experimental/blocked without secrets.

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

### Wave 1 transport completion gate (#121)

- At least one supported provider/access path exercises a true native OpenAI Responses upstream rail with Responses item identity, continuation fields, tool/reasoning item ordering, and #119 opaque artifacts preserved through provider invocation; same-protocol Responses fixtures never route through a lossy Chat-Completions approximation when the upstream supports Responses.
- Safe provider error status/code/type/retry-after/rate-limit metadata survives to the appropriate client/error policy; error redaction proves credentials, auth headers, secret-bearing bodies, prompts, responses, and reasoning text are excluded from logs/traces.
- Retry/failover decisions consume an explicit provider commitment state; a network failure with unknown provider outcome defaults to no replay/failover; failure after tool/client/provider commitment never rotates the account or replays the request.
- The conformance corpus (Anthropic + Responses native/supported paths: text, stream, tool, reasoning, continuation, stop, error, cancellation, retry metadata, disconnect ambiguity) records expected WIRE semantics; chaos tests cover failures at each commitment stage and prove no duplicate tool side effects; long-session soak combines #120 incremental transport with retry/error handling without state leakage or unbounded resource growth.
- Protocol compatibility docs distinguish exact native rails from weaker provider-specific compatibility surfaces, and Wave 1 completion evidence is sufficient for Wave 2 claim keying to exact protocol/adapter/access-path contracts.

### Standalone artifact gate (#35)

- A clean supported machine executes the packaged `rly` runtime WITHOUT a preinstalled Node/npm/pnpm toolchain (bundled pinned Node + self-locating launcher; `rly --version` passes from the unpacked artifact).
- The artifact build matrix explicitly covers or excludes each of darwin-arm64, darwin-x64, linux-x64, and linux-arm64; no target silently reuses incompatible bytes.
- Package content is generated from a positive allowlist and automated tests prove credentials, `.env`, local state, Git history, private reports, and unrelated workspace files are absent (packaging fails on unexpected files).
- The bundled Node/runtime version is pinned and appears in build metadata used by qualification/SBOM generation.
- Semantic version, source commit, build ID, platform target, and artifact digest are consistent with the #94 identity and are not split between `package.json`, the release tag, and runtime identity.
- Two artifacts with different bytes cannot claim the same exact build/artifact identity.
- Installed runtime/bootstrap paths are deterministic and consumable by #94 without a source checkout or invoking-shell PATH assumptions.
- The clean-artifact smoke test executes at least `rly --version` from the unpacked artifact for every supported CI target.
- npm/Homebrew, if introduced, consume the canonical artifact lineage rather than rebuilding a different product under the same version.
- Packaging/release docs and architecture identify standalone artifacts as the primary production distribution and external Node as a development concern only.

### Release supply chain gate (#128)

- Every advertised platform artifact has a canonical digest/build identity and a release manifest entry consistent with #94/#35.
- SBOM and provenance/attestation are generated from the exact release artifact lineage and reference the exact artifact digest.
- macOS production artifacts pass the documented signing/notarization/stapling verification gate before stable promotion.
- Signed channel metadata maps beta/stable to exact build/artifact identities and cannot be replaced undetectably by changing a GitHub `latest` target.
- Qualification installs and exercises the exact digest that is subsequently published/promoted; no rebuild occurs between qualification and publication.
- Clean install/init/service/readiness/update-handoff/uninstall qualification exists for each advertised stable target.
- A missing/failed required signing, SBOM/provenance, compatibility, or platform qualification gate prevents stable channel promotion.
- Stable artifact bytes cannot be silently replaced under the same exact build identity without verification failure.
- Release-critical third-party actions use reviewed pinned revisions or a documented equivalent supply-chain control.
- Release workflow permissions are minimal and secrets are not exposed in artifacts/logs/metadata.
- Beta/stable gate differences are machine-readable/documented and do not let beta evidence masquerade as stable qualification.
- Release/supply-chain/installation docs and RTM/AT identify exact-byte qualification as the publication authority.

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
