# RLY Gateway Architecture

## System intent

RLY Gateway is a local subscription orchestration fabric. Claude Code is the single coding harness; a profile name is the user-facing alias. The gateway preserves Anthropic Messages (and OpenAI Responses for the `rly run codex` escape hatch) while a self-owned local control plane manages providers, credentials, accounts, profiles, pools, health, and routing policy.

## Target layers

```text
Control plane
  ├─ provider/account/profile/pool configuration
  ├─ credential broker and project-owned secret records
  ├─ quota/health/cooldown and policy revision
  └─ authenticated management API and metadata-only audit
       ↓ versioned policy
Target launcher → Claude Code (`rly <profile>` or `rly run claude`)
                 → Codex CLI (`rly run codex` only)
       ↓ client protocol
Data plane
  ├─ decode and derive required capabilities
  ├─ request-time eligibility and account selection
  ├─ immutable EffectiveRoute with credential generation
  ├─ direct, OAuth, interoperability, or bridge adapter
  └─ protocol-preserving canonical event encoding
```

The Anthropic Messages protocol adapter and encoder are registered into the
foreground gateway when declarative direct routes, a selected OAuth account, or
an activated profile exists. Profile activation is lease-scoped: `rly <profile>`
and `run claude --profile` issue a child token bound to that profile. Each request then
performs eligibility and account selection through the pool; the profile never
preselects an account. Requests without a profile child token keep the
previous resolve order: TOML direct routes, then a manually selected Codex
account. OpenAI Responses is mounted beside Anthropic Messages and keeps
Responses item/event order; it shares control-plane eligibility and
EffectiveRoute selection.

## Implemented local foundation

The foreground launcher, runtime ownership store, and loopback server establish a safe local boundary for later protocol work. The executable owners are [`src/cli/main.ts`](../src/cli/main.ts), [`src/runtime/gateway-lifecycle.ts`](../src/runtime/gateway-lifecycle.ts), and [`src/runtime/runtime-store.ts`](../src/runtime/runtime-store.ts).

- `rly <profile>` launches Claude Code with that profile. `run claude` remains compatibility; `run codex` is the Codex CLI escape hatch. Both acquire one deterministic local gateway before launching the child; the child receives gateway settings without persistent global Claude or Codex configuration changes.
- Reuse requires a matching ownership record, process-start identity, config fingerprint, and fresh identity challenge proof. An occupied but unattested listener fails closed.
- Runtime files are outside Git, restricted to the current user, and reject link replacement. Startup and lease mutations use ownership-aware locking.
- Leases are heartbeated, expire after launcher loss, and trigger bounded idle cleanup. Diagnostics surface only an attested-compatible, foreign, stale, or absent lifecycle state.

## Persistent per-user resident runtime

`rly init` promotes the same foreground gateway into a per-user resident service without a second daemon or data plane:

- `rly init` settles the durable `~/.rly` home, validates the control-plane store, registers the per-user service (macOS LaunchAgent / Linux `systemd --user`, idempotent, no root), starts it, and waits for an attested compatible resident runtime.
- Resident ownership is a service lease renewed by the resident process itself, so the zero-lease idle shutdown never fires while the service is intentional. Child launch/session leases stay independent and revocable; closing a Claude/Codex child releases only its lease.
- `rly <profile>`, `rly config`, and diagnostics reuse the same attested resident runtime; the foreground launcher remains the fallback when no service is initialized.
- Explicit service stop is an attested, authenticated in-process `/shutdown` request: revoke launch sessions, bounded close, close broker/control-plane, clean owned runtime artifacts. An unknown port owner is never signaled.
- Crash recovery uses service-manager restart plus the existing startup-lock/process-identity rules; stale records are recovered and foreign listeners fail closed.
- `/identity` carries `runtimeVersion` and `resident` metadata for the version/protocol handshake (#73 update decisions). Platform specifics are owned by #33 (launchd) and #34 (systemd). See [ADR 0006](./adr/0006-persistent-user-runtime-service.md).

### User configuration control plane (`rly config`)

`rly config` is the primary user-facing control plane after `rly init` (#66). It productizes the existing management/control-plane boundary instead of composing low-level `rly admin` commands or hand-editing `gateway.config.toml`:

- Durable configuration resolution: `rly config` reads the `~/.rly/installation.json` record written by `rly init` and loads the recorded absolute config path, so it works from any working directory without a local `gateway.config.toml`. Explicit `--config` and the CWD file remain explicit dev/operator paths only; a missing recorded file falls back to the schema defaults (default loopback endpoints).
- Runtime ensure/recover: before any operation it inspects the attested runtime. A compatible resident or launcher-owned instance is reused as-is; when the resident service is installed but not running, the service manager starts it and the CLI waits for an attested compatible instance; uninitialized/dev checkouts fall back to a session-scoped foreground runtime. Foreign or incompatible listeners fail closed and are never signaled.
- Surface: bare `rly config` (or `rly config ui`) opens the local loopback config UI through the existing single-use fragment bootstrap (`/auth/bootstrap` → `HttpOnly`/`SameSite=Strict` session) and prints the URL in `--headless` mode; `rly config status` prints a secret-free summary (runtime state, policy revision, resource counts, health). Focused shortcuts (`providers`, `accounts`, `pools`, `profiles`) create/list through the same management endpoints and DTOs as `rly admin`, so both surfaces observe exactly one policy revision and cannot diverge into separate sources of truth.
- Credential flows reuse the credential broker: login/import/refresh/revoke persist only handle/generation metadata outside secret storage; the privacy allowlist is preserved end to end. Closing the config UI never stops the resident runtime.

### Profile-scoped Claude configuration views (#126, evolving #74)

RLY-launched Claude sessions point `CLAUDE_CONFIG_DIR` at a durable RLY-owned, profile-scoped view under the RLY user state root (`<control-plane>/claude/views/<view-id>`, `~/.rly/claude/views/<view-id>` by default) instead of a throwaway temp directory. Each RLY profile gets a deterministic view identity (`deriveClaudeViewId` from the immutable profile id; the reserved `default` view serves profile-less launches), so RLY-only gateway/model state is isolated both from plain `claude` launches and from other RLY profiles. The views give RLY sessions the user's normal Claude configuration as input while keeping RLY-owned model/default/cache/history state per profile:

- **Ownership is asymmetric**: the native Claude config root (parent `CLAUDE_CONFIG_DIR` or `~/.claude`) is read/compose-only input composed by `src/runtime/claude-overlay.ts::prepareClaudeOverlay`; RLY writes only inside the view with `0700` dirs / `0600` atomic files. Native `settings.json` (model key included), credentials, plugin metadata, history, and agent files are never rewritten; no post-exit restore of a saved global model exists.
- **Composition allowlist** (pinned to the supported Claude Code baseline `2.1.229` through #24): `settings.json` one-way merge that strips `env` keys conflicting with the child-only gateway contract (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_*`, `CODEX_*`) and drops unsupported credential-bearing shapes (`oauthAccounts`) while keeping unrelated settings and the native `model` as user input; user `agents/*.md`, `commands/*.md`, and `skills/**` one-way refresh copies; `plugins/config.json` enablement declaration only (`enabledPlugins`/`marketplaces`, credential-bearing keys dropped, plugin cache/repos never copied). Unknown files, history, projects, shell-snapshots, todos, statsig, and version are never copied. `~/.claude.json` (home level) and project-local `.claude` are never touched.
- **Typed env/settings ownership** (#126): every relevant setting classifies into RLY-owned (gateway-contract env keys; a persisted `claude-rly-*` projection model), conflicting (native `model` vs persisted/view state), safe pass-through (unrelated settings/env), unsupported (never composed), or explicit user override (launch-policy `model`/`env`, applied above native input but never persisted). Precedence is deterministic (high → low): child-only RLY gateway contract env, RLY-owned persisted projection model, explicit RLY/profile settings, user native settings/env, client persistence in the view, defaults. A conflicting native gateway/auth/model setting never overrides RLY's scoped launch contract silently.
- **Model persistence isolation**: a `claude-rly-*` projection model persisted by Claude `/model` lives only in its owning profile view (RLY-owned state wins on re-compose); another profile and a later plain `claude` launch read native state only and never inherit RLY gateway env, auth, or projection ids.
- **Ownership manifest and deletion reconciliation** (#126): each view carries `.rly-manifest.json` (metadata + sha256 hashes only) classifying every composed/persisted surface as native-imported, RLY-generated, or view-owned. An imported view file whose native source disappeared is deleted only when the manifest says native-imported AND the view copy still matches the imported hash; a divergent view copy is reclassified view-owned and kept. RLY never deletes a file it does not own as an import, and the previous additive-only ghost-file behavior is gone.
- **Refresh/precedence and concurrency** (#126): a file composes when missing or when native is newer, under the documented precedence — ownership wins over naive newer-mtime copy. Unchanged native input is not rewritten (sibling `/model` writes survive); malformed native JSON is skipped. RLY's own writes are atomic (temp + rename); the manifest read-modify-write and reconciliation are serialized per view with a bounded reconcile lock (best-effort when busy), so concurrent RLY launches converge without locks and native settings are never rewritten or restored.
- **Migration** (#126): the legacy shared `<control-plane>/claude` overlay (from #74) migrates into `views/default` exactly once via a crash-safe two-phase sibling rename; native `~/.claude` is never touched, and ambiguous shared persisted model/history state stays in the unprofiled `default` view, surfaced by `rly status`/`rly doctor` — never silently assigned to a profile.
- **Durability**: RLY session/history state under a view survives child exit and later RLY launches; `rly status`/`rly doctor` report per-view directory/source/allowlist version/composition timestamp plus ownership/reconciliation status and conflicting key categories only.

### Safe zero-downtime runtime update lifecycle (#73)

The update lifecycle is a coordinator over the existing primitives — the identity/version handshake (#65), bounded shutdown/lease revocation (`owned-gateway.ts`), the per-user service manager `restart()` (#33/#34), and the durable control plane — not a new daemon or data plane:

- **Installation ≠ activation.** `src/runtime/update/` owns durable secret-free update state (`<control-plane>/update-state.json`, `0600` atomic files) with states `idle`/`installing`/`pending-activation`/`activating`/`active`/`rollback-required`/`recovery-required`/`failed`. An installed candidate is never active until the restarted runtime passes identity/readiness verification.
- **Immutable deployment store and explicit refs (#92).** Deployments are content-addressed under `<control-plane>/runtime/versions/<artifactId>` where `artifactId` is a SHA-256 over the exact candidate tree bytes (semantic version is metadata only, never the storage key or uniqueness authority); byte-distinct candidates always receive distinct identities and a successfully installed immutable deployment is never recursively replaced (reinstall of the identical artifact is an idempotent no-write). Explicit references live under `<control-plane>/runtime/refs/` — `staged`, `active`, `previous` — as relative symlinks to validated immutable deployments. Installing a candidate may update only `staged`; switching `active` happens only through the explicit activation transition (`activateStaged`), and `previous` preserves the displaced deployment for rollback (#93 owns the transactional drain/fence gate around that switch). Reference replacement is atomic: temp-reference create + rename + parent-directory fsync, never `rm + symlink`, so readers observe either the old or the new valid reference, never an intentional missing intermediate state. A completed deployment layout (layout, identity, private `0700` dir / `0600` metadata) is validated before any reference exposes it.
- **Handshake.** `/identity` carries `runtimeVersion` (the actual serving binary version), `stateVersion` (durable schema), `update` (state + pending/previous versions + transaction phase), `activeSessions` (launch-session count, not TCP), and `draining`. The CLI applies the deterministic compatibility policy (`src/runtime/update/policy.ts`): same-major pairs may keep launching on the old runtime while pending; incompatible pairs refuse only new launches with an actionable `update-pending`/`runtime-version-mismatch` error — existing sessions are never touched.
- **Transactional activation (#93).** Activation is a durable transaction journaled on the update-state record: STAGED → DRAINING → SWITCHING → PROBATION → COMMITTING → COMMITTED (or ROLLING_BACK → COMMITTED | RECOVERY_REQUIRED). Each phase is written durably BEFORE the action it fences, and the journal carries the candidate/previous immutable deployment identities plus a bounded rollback-attempt counter — so a crash/reboot at any boundary makes one deterministic choice from durable evidence and NEVER guesses that a candidate committed before COMMITTED is durable. The new-launch fence (authenticated `POST /drain` refuses new launch-session issuance) is established BEFORE the serving ref switch; existing sessions complete naturally and in-flight streams/tool loops are never replayed. Probation accepts the candidate only after exact runtime identity, management/data protocol compatibility, authenticated readiness, and durable state/schema checks. Migration rollback safety is expressed as compatibility classes (`none`, `backward-compatible-expand`, `transactional-replace`, `forward-only`) replacing the binary `migrationForwardOnly`; `forward-only` blocks activation before destructive state change. Rollback is bounded to ONE attempt, re-establishes refs from journal evidence (previous written before active so the known-good reference is never lost), and failure terminates in the explicit `recovery-required` state with an actionable `rly doctor` path — never a restart loop.
- **Concurrency and crash recovery.** An ownership-aware update lock records the real OS process-start identity (never acquisition wall-clock time) and reclaims only locks whose owner identity is proven stale/dead; unverifiable owners are conservatively held. Crash/reboot states recover deterministically from the durable journal phase: interrupted install → `failed` with retry guidance; STAGED/DRAINING → resume activation; SWITCHING/PROBATION/COMMITTING → roll back to the durable previous known-good reference (never silently committing); COMMITTED → promote to active; interrupted or duplicate rollback → `recovery-required`. Legacy `<control-plane>/runtime/current`/`previous` + `versions/<semver>` layouts migrate in place (bytes renamed, never deleted) with a durable `migrating`/`committed` marker so a crash mid-migration resumes idempotently; the serving runtime is never removed before the new ref state is durable, and unknown/malformed legacy state fails closed with a doctor recovery path.
- **Distribution boundary.** #35 owns the signed/verified artifact distribution channel; the lifecycle consumes a `CandidateInstaller` contract (install/verify/restore + manifest) so a future channel plugs in without changing the state machine. A forward-only/unrollbackable candidate migration blocks activation before any destructive state change.

### Platform service adapters

`src/service-manager/` implements the per-user service contract per OS; command construction stays centralized there so init/update/status never grow separate launchctl/systemctl strings. The macOS LaunchAgent adapter (#33) installs one plist (`com.rly.gateway`) under `~/Library/LaunchAgents` (mode `0600`, directory `0700`), targets the current user's `gui/<uid>` domain without root, and refuses to run as root. It tolerates both launchctl v2 (`bootstrap`/`kickstart`/`bootout`/`print`) and legacy (`load`/`start`/`unload`/`list`) subcommands, repairs changed/stale definitions by unloading before reloading so launchd never keeps pointing at an old executable, bounds crash-restart with an explicit `ThrottleInterval`, writes service stdout/stderr into the durable RLY log directory, and removes only RLY-owned files on unregister (durable `~/.rly` data is never deleted). Service registration/load state and pid (`launchctl print`/`list` parsing) are reported separately from runtime `/identity` readiness; `rly status`/`rly gateway status` surface both using the privacy allowlist. The Linux `systemd --user` adapter (#34) installs one per-user unit (`rly-gateway.service`) under `~/.config/systemd/user` (mode `0600`, directory `0700`), never runs as root, and probes for a reachable user systemd manager (user D-Bus) before any mutating operation; a session without one (containers/minimal distros/WSL variants) fails actionably with explicit guidance that RLY never auto-enables `loginctl enable-linger`. The unit uses absolute executable/entrypoint/config paths and the durable `~/.rly` working directory, bounds crash-restart with `Restart=on-failure` plus explicit `RestartSec` and `StartLimitIntervalSec`/`StartLimitBurst`, appends service stdout/stderr into the durable RLY log directory, and holds no `Environment=` or credential/identity content. `daemon-reload` runs only when the definition changed, so re-running init repairs stale definitions without duplicate units; unregister `disable --now`s and removes only the RLY-owned unit (durable `~/.rly` data is never deleted). Unit enabled/active/process state (`systemctl --user show` parsing) is reported separately from runtime `/identity` readiness and surfaced by `rly status`/`rly gateway status` on the same privacy allowlist.

## Core contracts

### Client protocol adapter

- Decodes one client protocol into a tagged canonical request.
- Encodes canonical events back to the client protocol.
- Derives required capabilities before route invocation.
- Reports unsupported or lossy translations explicitly.

The implemented Anthropic adapter covers the Messages request shape used by the
contract fixtures: text, base64 images, tools/results, thinking and redacted
thinking input, tool choice, selected inference controls, stream preference,
beta metadata, and cache-control placement. Its encoder produces Anthropic
message JSON or SSE for canonical text, thinking, tool-argument deltas, usage,
stop, and error events. See [protocol compatibility](./protocol-compatibility.md)
for the exact boundary and its exclusions.

### Canonical request

Contains source protocol/client metadata, requested model and role, ordered
system/input/messages content, tools/tool choice, inference controls, stream
preference, and approved extensions. The current source union includes
Anthropic Messages and OpenAI Responses. Both protocols have decoder/encoder
implementations. Responses also has a private continuation store.

Content is a tagged union: text, image, tool call, tool result, reasoning, and redacted reasoning. Arbitrary upstream passthrough is not part of the contract.

### Canonical event stream

Events cover response/item/content start and completion, text/reasoning/tool-argument deltas, usage updates, completion, and failure. Every event has request identity, monotonic sequence, timestamp, and provenance.

### Policy revision and EffectiveRoute

Control plane publishes a versioned policy/configuration snapshot. Once a request is decoded, the route selector derives required capabilities, filters current account eligibility, applies the configured strategy, and creates one immutable `EffectiveRoute`. It records provider, model, adapter, account pseudonym, credential generation, source rule, policy revision, capability snapshot, and decision time; it never contains secret values or raw account identity.

### Model selection and account selection (two-stage boundary)

Model selection is a deterministic stage that runs **before** account selection (#68). Given an access provider, an optional preferred model family, an optional exact physical model pin, the decoded request's required capabilities, and a reasoning intent, the capability matching engine (`src/routing/model-selection/`) retrieves candidates from the trusted model intelligence registry, applies hard eligibility (exact evidence, protocol capabilities via the existing `CapabilityRequirement` semantics, reasoning semantics from `ReasoningCapabilityEvidence`, and compatibility state), then ranks deterministically in reviewed registry document order. It returns one frozen physical `ModelEvidence` target plus a secret-free decision trace; a typed failure (`unknown-exact-model`, `no-trusted-evidence`, `capability-unsupported`, `reasoning-unsupported`, `reasoning-translation-unsupported`, `reasoning-budget-policy-missing`, `compatibility-rejected`, `no-eligible-candidate`) is raised when no candidate is eligible. The existing `RouteSelector` still owns account eligibility, affinity, quota, pin order, retry safety, and credential generation within one pool; it never selects between physical models, and account retry/failover cannot change the frozen model. `BROKEN` compatibility is always rejected; `EXPERIMENTAL` is rejected by the default normal-user policy on the candidate path and requires an explicit opt-in (an explicit exact-model pin is itself an opt-in for that exact model). #69 owns tier/family preference ranking and cross-family fallback policy.

### Reasoning intelligence layer (#70)

A provider-neutral reasoning/thinking contract sits between decoding and adapter emission:

1. **Canonical intent** (`src/core/reasoning.ts`): `ReasoningRequest` carries the semantic intent (`OFF`/`ECONOMY`/`BALANCED`/`DEEP`/`MAXIMUM`/`AUTO`) plus source fidelity (`sourceMode`, `sourceEffort`, `explicit`). Decoders (Anthropic Messages, OpenAI Responses) derive it deterministically from the pinned supported-baseline wire shape; unknown additive fields stay recorded as ignored.
2. **Eligibility** (#68): explicit non-`OFF`/non-`AUTO` intents demand reasoning; combined with tool use they also demand `reasoningWithTools` evidence (fail closed via `reasoning-unsupported`).
3. **Translation** (`src/providers/reasoning.ts`): the provider-owned boundary `resolveReasoning(request, capability)` maps the canonical intent onto the selected model's `ReasoningCapabilityEvidence` control kind — discrete effort (exact same-family effort preserved; nearest reviewed level otherwise), binary, adaptive, token-budget (reviewed per-model policy only), or unsupported (fail closed unless explicit best-effort). The result (`ResolvedReasoning`) records the mapping kind (`exact`/`normalized`/`downgraded`/`default`) and fallback reason.
4. **Emission**: routing carries the translation result on the immutable route/decision; each provider adapter emits the exact native parameter (e.g. OpenAI-compatible `reasoning` object). Provider adapters own wire naming; core routing never hardcodes provider names.
5. **Observability**: `/v1/route-traces` carries requested/canonical/effective reasoning metadata plus mapping kind and fallback reason — never reasoning text, prompts, responses, credentials, or account identity.

### Logical model tier resolution (#69)

Portable logical model tiers (`haiku`/`sonnet`/`opus`/`fable`) resolve deterministically inside the **current execution context**, never as a global fixed mapping and never as "strongest across all providers":

- **Tier semantics**: a tier names a portable model class inside an access provider + model family. `fable` means the configured/verified strongest tier for the current model family/access path; multiple tiers may map to the same physical model when a family has fewer physical tiers. A tier is not an upstream model id and is never reinterpreted as one (exact physical ids keep the exact path via #68).
- **Resolution context** (`src/routing/model-tiers/types.ts`): `TierResolutionContext` carries `requestedTier`, `accessProviderId`, parent model id / `modelFamily`, an optional explicit user mapping, and explicit cross-family/cross-provider fallback flags. Access provider and model family are separate inputs on purpose.
- **Search order** (`src/routing/model-tiers/resolver.ts`, deterministic): (1) explicit user mapping validated through the #68 exact-pin path (`override-rejected` on unknown/BROKEN/unsupported); (2) reviewed/default mapping for `(provider, family, tier)` from the frozen, revisioned `defaultTierMapping` (`mapping-invalid` when the entry lost trusted evidence — never silently replaced); (3) deterministic #68 candidate evaluation inside the same provider+family (`derived`; default normal-user compatibility policy; a derived target is the deterministic #68 winner, not a claimed strength ranking — distinguishing multiple physical tiers inside one family requires reviewed/user mapping); (4) fallback scopes **only when explicitly enabled** (cross-family within the same provider, then cross-provider only with an explicit provider list) — every fallback is recorded in the trace.
- **Fail-closed**: unknown tier, unknown family on a multi-family provider without parent context (`family-unknown`), no eligible same-family target (`tier-unavailable`), invalid override, or invalid mapping each produce a typed `TierResolutionError` mapped onto the profile error contract (`tier-unavailable` code + typed reason); no silent cross-provider/cross-family substitution.
- **Stability**: the effective tier mapping is a frozen reviewed document (like the registry) plus profile overrides from the immutable policy snapshot; the trace records `mappingRevision` + `registryRevision`, and catalog refresh (#23) never mutates tier mappings.
- **Integration**: `resolveProfileRoute` resolves `model: <tier>` against the profile's pool provider and the parent model's family (parent = the profile's configured main model role), then feeds the exact physical target through #68 selection, #70 reasoning, and the existing pool/account selector (two-stage boundary unchanged). `ProfileDecisionTrace.tierResolution` carries the secret-free tier decision. `profile.modelRoles` accepts tier keys (`haiku`/`sonnet`/`opus`/`fable`) as per-profile user overrides through the existing management surface (#66).
- **Boundaries**: tier resolution never emits provider-native fields, never inspects prompts, and does not own subagent orchestration (#71) or `/v1/models` projection (#72). The supported Claude Code baseline's native `fable` alias behavior is classified by #24; RLY still resolves the alias contextually.

### Model intent and selector namespaces (#125)

Before any routing, the incoming model selector string is classified into one typed **model intent** (`src/routing/model-intent/`), separating the client-native alias vocabulary (owned by Claude/Codex) from the RLY logical selector namespace. Core invariant: `fable != rly-tier:fable`.

- **Typed intent kinds** (`src/routing/model-intent/types.ts`): `EXACT_PROJECTION`, `RLY_LOGICAL_TIER`, `CLIENT_NATIVE_ALIAS`, `EXACT_CLIENT_MODEL`, `INHERIT`, `DEFAULT`. Every classified intent preserves its exact `sourceSelector` and the `source` namespace/rule that produced it (provenance for diagnostics); no selector string is ever rewritten.
- **RLY logical selector namespace**: RLY-owned tiers are addressed only through the explicit `rly-tier:<tier>` namespace (`rly-tier:haiku|sonnet|opus|fable`). A selector claiming the namespace with an unknown value fails closed (`unknown-namespace`) and is never silently reinterpreted as an alias/exact model. Bare `haiku|sonnet|opus|fable` strings are client-native aliases classified through the explicit, traceable client-alias contract and are never RLY policy selectors by string equality.
- **Deterministic precedence** (`src/routing/model-intent/classify.ts`, highest → lowest): explicit `rly-tier:` namespace → RLY projection namespace (`claude-rly-*`) → client-native alias vocabulary → `inherit` → empty/`default` → exact client model id / profile role / helper alias. Identical selectors always classify identically.
- **Routing integration** (`src/profiles/resolve-route.ts`): `resolveProfileRoute` classifies the selector into a `ModelIntent` first; the #69 provider/family tier resolver is invoked **only** for an explicitly typed tier intent (`RLY_LOGICAL_TIER`, or a client-native alias mapped through the alias contract) — never by accidental string matching. `EXACT_CLIENT_MODEL`/`DEFAULT`/`INHERIT` resolve through the profile role/helper/exact-model mapping; `EXACT_PROJECTION` selectors are dispatched by `resolveProjectedModelRoute` (#72) before profile resolution and fail closed if they ever reach it. The classifier-computed role/model id is authoritative for every intent kind: `activateProfile` never re-derives a role from the raw selector string.
- **Error taxonomy** (`src/routing/model-intent/errors.ts`): classification failures are typed (`unknown-namespace`, `unsupported-client-alias`, `invalid-projection`, `conflicting-selector-sources`) and mapped onto the existing profile error contract (`role-unmapped` + additive `reason`); downstream stages keep their own typed failures (unknown exact model → #68 `capability-rejected`, invalid projection → `model-unavailable`, tier unavailable → `tier-unavailable`).
- **Diagnostics**: `/v1/route-traces` carries the classified intent as `ProfileDecisionTrace.intent` — selector kind/source and the resolved logical target only. Never prompts, credentials, account identity, or settings contents.
- **Migration/compatibility**: bare-tier selectors and `profile.modelRoles` tier keys keep their pre-#125 meaning through the explicit classification contract; persisted exact model ids are never reinterpreted as tiers (exact ids keep the exact path via #68).

### Native protocol rails and fidelity envelope (#119)

RLY keeps three separate authorities for protocol fidelity — the **native
protocol rail**, the **semantic projection**, and the **fidelity/continuation
envelope** — so the semantic IR never becomes the only source of truth when the
client/provider contract requires exact opaque state on later turns.

- **Native protocol rail**: the Anthropic Messages and OpenAI Responses
  encoder/decoder wire shapes remain the source of wire truth for same-protocol
  traffic. Same-protocol forwarding patches only RLY-owned controls (selected
  model/auth/endpoint); native state is never flattened into the semantic core.
- **Semantic projection**: `CanonicalRequest` / `CanonicalEvent` stay focused on
  routing, capability, tool, reasoning intent, diagnostics, and cross-protocol
  translation. Provider-specific opaque fields are deliberately not forced into
  semantic core types.
- **Fidelity envelope** (`src/core/fidelity.ts`, version 1): versioned metadata
  with source protocol/revision, typed opaque continuation artifacts
  (`OpaqueArtifact`: kind, stable association, value), translation provenance
  notes (`preserved-native` / `translated` / `ignored` / `unsupported`), and
  the required artifact kinds for a compatibility claim. Adapters/protocol
  codecs may preserve opaque artifacts; routing policy inspects only explicitly
  modeled safe metadata (kind, association, disposition) — never artifact
  values. `emptyFidelityEnvelope` / `withArtifacts` / `withNotes` /
  `withRequired` / `mergeFidelity` build the envelope; `artifactValue` is the
  explicit association lookup; `unsupportedRequiredArtifacts` implements the
  fail-closed gate; `describeFidelity()` is the only diagnostic surface and
  returns provenance metadata only.
- **Anthropic fidelity**: the decoder preserves `thinking.signature` into the
  envelope (required when present) and records the thinking-text projection as
  `translated`; the canonical stream gains `signature-delta` events; the
  encoder emits `signature_delta` in valid order (after `thinking_delta`,
  before `content_block_stop`) and fails closed (`invalid_event_order`) on a
  non-thinking block or an out-of-order delta; the aggregator attaches the
  signature to the aggregate thinking block. Byte-level SSE is pinned by a
  golden fixture.
- **OpenAI Responses fidelity**: the decoder preserves reasoning item identity
  (semantic, non-secret) and opaque `encrypted_content` (envelope, required
  when present); `ResponseContinuationStore` persists the fidelity envelope
  with the stored output and merges prior artifacts into a subsequent
  `previous_response_id` request; re-encode attaches each reasoning item's
  exact encrypted content. Opaque content is never reconstructed from summary
  text.
- **Fail-closed policy**: a compatibility claim requiring an artifact cannot
  pass when the selected translation path cannot preserve it. The Chat
  Completions transport (OpenRouter/DeepSeek adapters) cannot represent
  signatures or encrypted content, so `OpenAiChatAdapter.invoke` raises
  `unsupported-fidelity` before any upstream call.
- **Extension points**: `OpaqueArtifactKind` is a typed union, so future
  Gemini thought signatures, OpenRouter reasoning details, DeepSeek reasoning
  continuation, and other provider-owned opaque artifacts extend the envelope
  without redesigning canonical routing.
- **Privacy**: opaque artifact values are runtime/protocol state, never
  diagnostics — never logged, never in route traces, never in diagnostic
  bundles; the observability redactor treats artifact-bearing keys as
  sensitive. Continuation persistence applies the existing private-file/storage
  rules.

### Claude Code subagent execution context (#71)

Claude Code orchestrates agents; RLY resolves their requested execution target
and reasoning safely. The gateway carries subagent attribution end to end
without becoming a workflow engine or inspecting prompts:

- **Ingress**: the Anthropic decoder parses `X-Claude-Code-Session-Id`,
  `X-Claude-Code-Agent-Id`, and `X-Claude-Code-Parent-Agent-Id` into a typed
  `AgentContext` on the canonical request (`src/core/agent-context.ts`). These
  are runtime attribution data, never permission/authentication; RLY launch/gateway
  tokens remain the authorization boundary.
- **Execution-context registry** (`src/profiles/agent-contexts.ts`): an
  in-memory, lease-scoped registry records each agent's resolved execution
  context (launch/profile binding, access provider, frozen physical model id,
  model family, effective tier, mapping/registry revisions) after a successful
  resolution. Entries mirror the `LaunchSessionRegistry` security boundary:
  valid only while the owning lease is active, removed on lease revocation
  (`dropLease`) or expiry, and cleared on runtime restart. Never stores
  credentials, account ids, or account identity.
- **Parent-context resolution**: a subagent tier request inherits its parent's
  frozen physical model/family — exact `(session, parentAgentId)` match, then
  the session's main context, then the launch session's unambiguous
  profile-default model. The fallback never selects another subagent's
  context, so one subagent's model cannot leak into another's resolution.
  When no parent/session family is determinable on a multi-family provider,
  #69 fails closed (`family-unknown` → `tier-unavailable`) instead of choosing
  a global strongest model.
- **Pipeline**: the resolved parent context feeds #69 tier resolution, then
  #68 exact capability/compatibility selection, then #70 reasoning translation,
  then the existing pool/account selector for the frozen physical model — the
  two-stage boundary is unchanged. A subagent's resolution never mutates the
  parent/main session model, profile mapping, or global Claude settings;
  concurrent subagents with different agent ids resolve independently.
- **Fail-closed**: unknown tier, missing evidence, unsatisfied capability,
  reasoning-with-tools gap, or undeterminable family produce actionable typed
  errors (`tier-unavailable`/`capability-rejected` plus the underlying cause);
  there is no silent fallback to the parent model and no global
  `CLAUDE_CODE_SUBAGENT_MODEL` override. The source agent/skill definition
  (`model: fable`) is never rewritten to a physical model.
- **Trace/privacy**: `/v1/route-traces` may carry allowlisted pseudonyms
  (hashes) for Claude session/agent/parent linkage plus the parent
  model/family that scoped tier resolution; never prompts, reasoning text,
  credentials, or durable user identity. The supported Claude Code baseline's
  native `fable` alias behavior is classified by #24 canaries; the gated
  real-client E2E pins the gateway plumbing on the observed client.

### Gateway model discovery and projection (#72)

`GET /v1/models` on the **gateway listener** (not the management listener) exposes the configured, trusted RLY model universe to Claude Code through the supported Anthropic Messages discovery wire contract, and every selected `claude-rly-*` projection id routes back to one exact access-provider/model target + provider pool:

- **Projection module** (`src/routing/model-projection/`): pure, deterministic, secret-free. `RLY_MODEL_PREFIX` (`claude-rly-`) is the canonical Claude-compatible projection namespace (re-exported by the overlay for #74 isolation). `projectModelUniverse(registry, snapshot)` projects trusted registry models through a session's pinned provider→pool bindings (`VERIFIED` by default; `EXPERIMENTAL` only with the explicit `gateway.modelDiscovery.experimentalModels` config opt-in; `BROKEN`/unreviewed/proposed never). `resolveProjection(id, snapshot, registry)` is the explicit reverse mapping — routing never parses id strings, and a removed/BROKEN/ineligible target fails closed rather than substituting another model.
- **Session universe snapshot**: compiled at `POST /v1/launch-sessions` from the control-plane policy and pinned in the session — policy revision/hash, registry revision, provider→pool bindings (the profile's own pool plus every other enabled provider with exactly one eligible default pool; multiple-pool providers without an explicit binding are excluded — RLY never chooses an arbitrary pool), and the experimental-model policy. A policy/registry change mid-session never silently remaps an already-issued projection id.
- **Routing**: a request whose model is a projection id resolves through the session's reverse mapping to the exact (provider, model, pool), then runs the unchanged two-stage boundary — #68 exact selection, #70 reasoning translation, then pool/account selection inside the pinned pool. Unknown/removed/BROKEN targets raise a typed `model-unavailable`/`capability-rejected` error. `route-trace` carries the projection id/display name as allowlisted metadata followed by the exact model/account decisions.
- **Child launch**: RLY-launched Claude children get child-only `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`; the overlay strips that key from native settings env (allowlist v2) so an RLY session cannot be silently disabled and a plain `claude` launch never inherits RLY discovery env, auth, or projection ids.
- **Boundaries**: discovery is presentation + exact-target selection; #67 remains canonical evidence, #69 remains contextual tier resolution, #23 refresh never mutates projections, and the account selector remains the account/credential authority.

### Provider adapter

- `probe`: reports readiness without leaking credential or account identity.
- `capabilities`: describes verified model behavior.
- `invoke`: returns canonical events and accepts cancellation.
- `countTokens`: optional and must declare quality.

## Model intelligence registry

The registry in [`src/registry/model-registry.ts`](../src/registry/model-registry.ts) is the canonical model-data layer and the source of truth for provider/model identity and evidence (#68-#72). It records, per exact access path:

- `identity`: access provider, exact upstream model id, and upstream/model family (classification metadata only — never a route, credential, or account key).
- capability evidence: the protocol flags (`ProviderCapabilities`) plus typed reasoning controls (effort kind/levels, adaptive, token budget, reasoning-with-tools) and reviewed operational limits (context window, max output) when evidenced.
- compatibility state: `VERIFIED`/`EXPERIMENTAL`/`BROKEN` for the RLY Claude Code baseline, kept separate from raw capability support, with the tested baseline, evidence reference, and check date.
- provenance: `verifiedAt`, fixture version, and registry document revision.

Invariants:

- Exact `(accessProvider, upstreamModelId)` matching only; the same upstream model id reachable through two access providers stays two separately verified entries and never satisfies each other's lookup. Missing or cross-provider evidence fails closed.
- One canonical shape covers native/direct, OAuth/bridge, ClinePass, and OpenRouter/aggregator paths. Aggregators expose many model families without extra provider records or parallel registries.
- Provider probes and catalog discovery report drift but never mutate the trusted document; discovery diffs against reviewed evidence and returns proposed candidates for the #23 propose-only review workflow.
- **Propose-only catalog refresh (#23 / BL-042):** `rly admin models refresh|proposals` runs the discovery pipeline (`src/providers/catalog-discovery.ts` → `src/registry/catalog-proposal.ts` → `src/registry/proposal-store.ts`) and persists a deterministic drift report (new / changed / removed / unchanged + reviewed evidence references) as a metadata-only artifact under `<control-plane>/proposals/<provider>.json` — **separate from trusted evidence**. The refresh command never mutates the trusted registry, profile tier mappings, `/v1/models` projections, or active session policy; promotion of proposed evidence is a separate reviewed control-plane operation (#69/#72). Provider-reported fields (tools/reasoning/limits) are labeled declared/observed until reviewed; #24 canary references are carried from reviewed entries only and never fabricate a pass. Errors are privacy-redacted before output/persistence.
- No credentials, account identity, prompts, or responses are stored in model evidence or proposals.

Deterministic query helpers (`modelsForProvider`, `modelsForFamily`, `modelsSatisfying`, `modelsRequiringCapabilities`, `modelsWithCompatibility`) support #68/#69 candidate retrieval without account selection or credential access. Account/credential eligibility and selection remain owned by the pool/route selector.

## Direct provider boundary

Direct adapters resolve only allowlisted secret references. They never read arbitrary process environment names or committed raw secrets. OpenAI-compatible transport does not imply identical provider behavior; reasoning replay, tool support, errors, usage, and catalogs remain adapter-specific.

## Control-plane boundaries

### Credential broker

The broker is the only owner of project-managed credential persistence. It performs explicit import/login, refresh single-flight, generation compare-and-swap, atomic replacement, backup, and recovery. Secret records live outside Git and SQLite in a restrictive project-owned store or approved OS backend. Provider adapters receive request-scoped credentials and cannot independently persist them.

### Accounts and pools

Account metadata is separate from credentials. Account identity is unique per `(provider, pseudonym)`. Pool selection always filters paused, expired, authentication-unready, cooling, capability-incompatible, or terms-unaccepted accounts before applying manual pin, `round-robin`, `fill-first`, or an evidence-approved quota strategy. Quota-exhausted accounts are ineligible only while cooling and become recovery probes afterward. A request never changes account after the first response byte or tool event.

### Management

Management and data paths use separate routers/listeners even when hosted by one process. Data defaults to `127.0.0.1:17871`; management defaults to `127.0.0.1:17872`. Both share the attested instance lifecycle, collision preflight, and teardown contract but use separate secrets. CLI management uses a per-instance bearer. Browser access exchanges a launcher-issued, single-use, short-lived URL-fragment token for an `HttpOnly`, `SameSite=Strict` cookie, then removes the fragment from history. Management enforces exact loopback Origin, CSRF, bounded sessions, versioned mutations, migration/recovery, and secret-free DTOs. UI never reads stores directly.

## Managed bridge boundary

Managed bridges are semi-trusted external dependencies. The gateway verifies configured endpoint, identity, version, protocol, and capabilities. They remain available when a provider is better served by bridge-owned installation, OAuth, accounts, refresh, or process lifecycle.

Readiness has three states:

1. reachable;
2. authenticated;
3. requested model usable.

Unknown identity or protocol-breaking version fails closed.

## Runtime and ownership invariants

- Loopback-only default endpoint: `127.0.0.1:17871`.
- Transient gateway token authenticates harness requests.
- Atomic startup lock must prevent duplicate races.
- Ownership record must include PID/start identity, instance UUID, executable/config fingerprint, nonce hash, launcher owner, and active leases.
- Reuse must require matching attestation and config.
- Foreign port owner must never be signaled.
- Gateway must shut down only according to its own leases and grace period; an intentional resident service holds a service lease so it never enters zero-lease idle shutdown.

## Data and persistence

SQLite owns versioned non-secret provider/account/profile/pool/health/policy/audit metadata and migrations. Project-owned OAuth secret records live outside SQLite and Git with restrictive permissions and atomic persistence. Runtime ownership files remain separate from business/control-plane state. Response or prompt bodies are not durable control-plane data.

## Observability

Structured logs default to metadata only. Route trace explains an explicit decision without prompt or secret data. Liveness is minimal; readiness is authenticated and route-specific.

## Compatibility strategy

- Protocol fixtures carry client/protocol version evidence.
- The model intelligence registry records `registryRevision`, model `verifiedAt`, fixture revision, token-count quality, reasoning/limit metadata, and typed compatibility state (baseline + evidence reference).
- Unknown required behavior disables readiness rather than silently degrading.
- Protocol drift begins with a redacted reproducing fixture.

## Runtime compatibility canary (#24)

A runtime compatibility evidence gate (`src/canary/`, CLI `rly canary run|status`) separates client compatibility from model access-path compatibility and never collapses them into one global "model works" flag:

- **Version detection** (`src/targets/versions.ts`): exact semantic/version read from the client's own `--version` output; binary presence is `found`, never `compatible`; unknown versions surface `unknown/not-tested` and never replace the tested baseline. The pinned fixture baseline is `claude-code-2.1.229`; observed clients (2.1.231, Codex `0.147.0-alpha.6.5`) are recorded separately and are not baselines.
- **Pinned contract fixtures**: Claude Code session/agent/parent attribution headers, gateway `GET /v1/models` request/auth/response selection (id-prefix filter + startup cache), `fable`/`haiku`/`sonnet`/`opus` aliases, subagent/session `effort` additive field, streaming framing, and `--no-session-persistence`; a changed contract fails the exact gate with a typed reason.
- **Deterministic fake gate matrix** per exact access path: text, streaming, cancellation, single/multi/parallel tool loops, reasoning, reasoning+tools, model discovery, session attribution, subagent routing, parallel subagents, effort signal, long-running session. Capability-dependent gates are `not-run` without reviewed evidence (never advertised stronger than proven).
- **Classification** (#122): the deterministic matrix classifies each exact path `EXPERIMENTAL` (full Layer A pass; production trust requires Layer B/C evidence plus reviewed promotion, #124), `BROKEN` (required contract fails), or `unknown` (required gates unrun, never reported as passed). `livePassed`/`liveEvidence` are removed; no observation can emit `VERIFIED`.
- **Evidence identity**: exact client kind/version + access provider + adapter + physical model (+ family); no cross-provider reuse.
- **Artifacts**: `rly canary run` persists secret-free machine-readable evidence under `<control-plane>/canary/` for #23/#67 review tooling; `proposeCanaryState` reports drift and never mutates trusted registry evidence, tier mappings, or `/v1/models` projection. The #72 projection gate consumes canary-derived compatibility state (VERIFIED default, EXPERIMENTAL opt-in, BROKEN/unreviewed never). Live provider runs stay opt-in (`RLY_LIVE_CANARY=1`, skipped ≠ pass); the switch only enables execution and never creates evidence.
- **Privacy**: artifacts/logs carry client/provider/model ids, gate names, status, fixture revision, and redacted error categories only — never prompts, responses, reasoning text, credentials, or account identity.

### Compatibility Claim and Evidence v2 (#122)

A versioned, feature-scoped Compatibility Claim + Evidence model (`src/canary/claim.ts`) replaces the coarse `livePassed` boolean as the authority layer between observations and reviewed decisions:

- **Claim identity**: a stable versioned key (`claimKeyFor`) includes client kind, exact client version/baseline, source protocol/revision (#119 vocabulary), adapter/integration surface, access provider, auth mode, endpoint contract, exact physical model, and feature/capability claim. Model family is metadata only and never part of the key. Same upstream model through two providers, and two features on the same path, produce distinct keys/documents/histories — no cross-provider/model/feature reuse.
- **Evidence layers**: Layer A = deterministic fake-matrix conformance (the current canary matrix is reclassified as Layer A); Layer B = exact installed-client black-box behavior (`src/canary/installed-runner.ts`, built by #123); Layer C = exact real access-path live verification (`src/canary/live-runner.ts`, built by #123). Required layers are declared per adapter (`requiredLayersForAdapter`; unknown adapters fail closed); layer presence/result is explicit per claim, never collapsed into one boolean. A claim is `missing` with no observations, `failed` on any failed observation, `not-run` while a required layer lacks a passing record, and `passed` only when every required layer has a passing record.
- **No boolean trust**: `livePassed`/`liveEvidence` are gone from the authoritative classification path; classification can never emit `VERIFIED` from an observation. `RLY_LIVE_CANARY`/`liveRunnerEnabled` may enable a runner hook but can never stand in for an evidence artifact.
- **Schema/legacy**: claim documents are `schemaVersion` 1 and evidence `evidenceSchemaVersion` 2; legacy v1 canary outputs are flagged legacy/untrusted (`legacy-v1-artifact-untrusted-for-v2-claims`) and can never silently satisfy a v2 claim. Registry revision 5 adds an optional `claimRef` to `CompatibilityEvidence`; pre-v5 rows are untrusted for v2 claim authority.
- **Persistence/query**: append/audit-friendly claim store under `<control-plane>/claims/` (`ClaimEvidenceStore`): atomic writes, appended records (identical observations deduped), fail-closed malformed reads, deterministic lookup by exact claim identity + feature.

### Installed-client (Layer B) and live access-path (Layer C) runners (#123)

The two observation runners that produce the exact-client/access-path evidence for #122 claims live in `src/canary/`:

- **Layer B — installed-client black-box runner** (`src/canary/installed-runner.ts`): a controlled local fixture server (Anthropic Messages + `GET /v1/models`, OpenAI Responses + `GET /v1/models`) receives requests from the REAL installed Claude Code / Codex CLI binary, launched child-only (fixture base URL, synthetic token, throwaway config dir — never real client config, never real credentials). Each gate drives one client behavior (framing, streaming, cancellation, tool round-trip, multi-tool/parallel continuation, reasoning/effort, reasoning+tools, discovery/selection, session/agent/parent attribution, tier aliases, subagent concurrency, config-overlay, long sessions) and emits one Evidence Artifact v2 keyed to the EXACT observed client version; the reviewed supported baseline is recorded separately and never implied (drift surveillance — new versions tested without auto-promotion). A missing/non-executable binary reports every gate `not-run` (`client-not-installed`). `invoke` override + fake-client fixtures (`tests/fixtures/clients/`) make the harness deterministic in CI; real-binary sentinels are opt-in (`RLY_CLAUDE_E2E=1`, `RLY_CODEX_E2E=1`; skipped ≠ pass).
- **Layer C — exact access-path live runner** (`src/canary/live-runner.ts`): spins an in-process RLY gateway configured with the EXACT claim path (client + client version + protocol/revision + adapter + provider + auth mode + endpoint + physical model), routed via `createDirectRouteResolver` to the configured provider endpoint, and exercises each feature gate over the client-facing surface with an environment credential (never stored/logged). Feature-scoped Evidence v2 (`text` cannot promote tools/reasoning/discovery); no cross-provider sharing; tool continuation proven only when the provider returns tool calls; policy-driven `GET /v1/models` discovery served from a throwaway control-plane store (the real control plane is never touched). Layer C runs ONLY with `RLY_LIVE_CANARY=1` and available credentials; missing credentials / skipped / unexecuted gates are `not-run` — never `passed`, never `VERIFIED`, never silently spending quota.
- **Evidence plumbing**: additive optional `timingMs` on Evidence Artifact v2 (backward-compatible with #122 artifacts); `RunnerResultStore` persists metadata-only raw results under `<control-plane>/canary-runners/` (0700/0600) with Evidence v2 `ref`s; CLI `rly canary run-b|run-c` persists raw results and appends claim documents. Both runners are observation-only — they never mutate the trusted registry, tier mappings, `/v1/models` projection, or effective compatibility state; review/promotion is #124.

## Security boundaries

- Loopback is not sufficient; transient authentication is mandatory.
- No retry after response first byte or a tool event.
- No global client configuration mutation: RLY never rewrites native Claude/Codex config; RLY-owned Claude config lives only in durable profile-scoped views under the RLY home (#74/#126).
- No silent credential discovery/import.
- Credential broker owns all project-managed secret writes.
- Management API never returns raw secret or account identity.
- Pool selection binds one credential generation per request and cannot rotate after output begins.
- No prompt/body logs by default.
- Existing services on protected ports are outside project ownership.

## Architecture decisions

- [Protocol-preserving IR](./adr/0001-protocol-preserving-ir.md)
- [Managed bridge boundary](./adr/0002-managed-bridge-boundary.md)
- [Transient launcher ownership](./adr/0003-transient-launcher-ownership.md)
- [Self-owned control plane and credentials](./adr/0004-self-owned-control-plane-and-credentials.md)
- [Request-time account routing](./adr/0005-request-time-account-routing.md)
- [Persistent per-user runtime service](./adr/0006-persistent-user-runtime-service.md)

## Unresolved questions

- Exact provider interoperability modes after the first Codex OAuth slice remain evidence-driven.
