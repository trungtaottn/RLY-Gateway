# Protocol compatibility

This document records the implemented, test-backed protocol boundary. Direct
routes are operational only when a configured model has current registry
evidence and passes the opt-in live smoke; no live route is claimed here.

## Anthropic Messages

The Phase 03 boundary exposes registration helpers for `POST /v1/messages` and
`POST /v1/messages/count_tokens`. They translate between Anthropic Messages
payloads and the canonical request/event types. Integration tests mount these
helpers with a fake canonical upstream.

| Area | Supported boundary behavior | Limits and readiness condition |
| --- | --- | --- |
| Requests | `model`, `max_tokens`, ordered user/assistant messages, text, base64 images, tool use/results, system text, tools, tool choice, stream, temperature, top-p, stop sequences, thinking, beta header, and cache-control placement | Unknown top-level additive fields are recorded as ignored. Required capability support is checked against the selected immutable route before upstream invocation. |
| Streaming | Anthropic SSE message/content start and stop, text/thinking/tool-argument deltas, usage, stop reason, and terminal message stop | Event sequence and request provenance must be monotonic and consistent. The runtime mounts direct routes only with a transient gateway token. |
| Non-streaming | Canonical text, thinking, tool-call arguments, usage, and stop reason aggregate into an Anthropic message response | Tool argument fragments must form valid JSON. Upstream failures become structured gateway errors. |
| Token counting | Direct routes use an explicit conservative estimate or `501` when declared unsupported | Quality is sent in `x-rly-gateway-token-count-quality`; no provider tokenizer parity is claimed without adapter evidence. |
| Retry and cancellation | Non-stream collection retries once only when a transport error occurs before any canonical event. Client abort is propagated to the route upstream signal. | Streaming retry, real-provider cancellation, and backpressure still require Phase 04/provider-runtime evidence. |

## Model intelligence registry

[`src/registry/model-registry.ts`](../src/registry/model-registry.ts) is the canonical model-data layer and the source of truth for provider/model identity and evidence used by #68-#72. Evidence ownership is explicit:

- **Reviewed/static evidence** (trusted, reviewed before commit): access provider identity, exact upstream model id, upstream/model family classification, protocol capability flags, token-count quality, `verifiedAt`, fixture version, and numeric limits only when a review produced them. No quality numbers are invented from reputation.
- **Observed/discovered metadata** (untrusted until reviewed): discovery snapshots from provider adapters/catalog sources. `proposeRegistryChanges()` diffs a snapshot against trusted evidence and returns proposed candidates (`no-exact-evidence`) for the #23 propose-only review workflow. Discovery never mutates the trusted document.
- **Canary-produced** (produced by #24): the typed compatibility state (`VERIFIED`/`EXPERIMENTAL`/`BROKEN`) plus the tested baseline, evidence reference, and check date. Compatibility state is separate from raw capability support.
- **Never stored**: credentials, account identity, prompts, or responses.

Exact `(accessProvider, upstreamModelId)` matching fails closed on missing or cross-provider evidence; the same upstream model id through two access providers remains two separate entries. Aggregators (ClinePass/OpenRouter) expose many model families through one canonical shape without parallel registries. `ProviderRecord.capabilityEvidence` is typed against the registry schema (was `unknown`) and validated at the management boundary.

## Explicitly unsupported or not yet operational

- Direct providers currently use Chat Completions transport. OpenRouter probes
  its models catalog and DeepSeek preserves assistant reasoning content when
  replaying a tool turn. Probe results never mutate declarative configuration.
- Roles are exactly `primary`, `fast`, and `reasoning`. A request may name a
  configured role, its exact configured model ID, or a known Claude helper
  alias (`claude-haiku-4-5` → `fast`, `claude-sonnet-5` / `claude-opus-4-8` →
  `primary`). Unknown helpers fail closed. Profile-scoped helpers stay inside
  the activated profile's model-role map. Tier aliases (`haiku`/`sonnet`/
  `opus`/`fable`) are resolved contextually by #69, not through the helper map
  (see below).
- No live provider smoke or real token-count validation has been recorded yet.
- Direct adapters still speak Chat Completions transport; Responses is a client
  protocol boundary, not a new upstream wire format.

## OpenAI Responses

The Phase 11 boundary exposes `POST /v1/responses` and `GET /v1/responses/:id`.
They translate between OpenAI Responses items/events and the same canonical
request/event types used by Anthropic Messages. Unknown required item, tool,
or include values mark the route unready instead of flattening into Anthropic
ordering.

| Area | Supported boundary behavior | Limits and readiness condition |
| --- | --- | --- |
| Requests | `model`, string or item `input`, `instructions`, function tools, tool choice, stream, `previous_response_id`, max output tokens, temperature, top-p, reasoning effort | Unknown required item/tool/include values fail closed as `compatibility_unready`. Additive unknown top-level fields are recorded as ignored. |
| Streaming | `response.created`, `response.in_progress`, output item add/done, `output_text` / function-argument / reasoning-summary deltas, `response.completed`, `response.failed` | Event sequence and request provenance must be monotonic. Client abort is bound to the upstream signal. |
| Non-streaming | Canonical text, function-call arguments, reasoning summary, and usage aggregate into a Responses object | Function argument fragments must form valid JSON. |
| Continuation | Completed responses persist canonical output items; a later `previous_response_id` prepends that output | Missing or expired ids are unready. Retention deletes expired continuation files. |

`run codex` launches Codex with `OPENAI_BASE_URL` / `OPENAI_API_KEY` and a
temporary `CODEX_HOME`. Global `~/.codex` is not mutated.

## Profile-scoped Claude configuration views (#126, evolving #74)

RLY-launched Claude sessions do not use a throwaway `CLAUDE_CONFIG_DIR` temp
directory. The launcher (`src/cli/main.ts`) prepares a durable RLY-owned,
profile-scoped view (`<control-plane>/claude/views/<view-id>`, `~/.rly/claude/views/<view-id>`
by default; `deriveClaudeViewId(profileId)` for profile launches, reserved
`default` for profile-less launches) with
[`src/runtime/claude-overlay.ts`](../src/runtime/claude-overlay.ts) and passes
it as the child `CLAUDE_CONFIG_DIR`. The native user config root is composed
as read-only input through a typed allowlist; each RLY profile gets its own
view so RLY-only model/default/cache/history state never bleeds between
profiles. `CLAUDE_CONFIG_DIR` layout pinned for the supported baseline
(currently observed `2.1.229`, fixtures owned by #24):

| Surface | RLY composition |
| --- | --- |
| `settings.json` | One-way merge: unrelated keys and native `model` preserved; `env` keys conflicting with the RLY gateway contract (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `CODEX_HOME`, `CODEX_API_KEY`) stripped; unsupported credential-bearing shapes (`oauthAccounts`) never composed; a persisted RLY-only `claude-rly-*` model is RLY-owned and wins on re-compose. Written only in the view. |
| `agents/*.md`, `commands/*.md` | One-way refresh copy when missing or native is newer; imported copies are removed/reconciled when the native source disappears (ownership manifest + hash match; divergent copies reclassified view-owned). |
| `skills/**` | Allowlisted recursive copy of user-authored skills (`node_modules`, `.git` excluded; symlinks never followed); deletion reconciliation as for agents/commands. |
| `plugins/config.json` | Only `enabledPlugins`/`marketplaces` carried; `oauthAccounts`/token-like keys and plugin cache/repos never copied (plugin runtime state stays native); the allowlist projection is removed/reconciled when the native file disappears. |
| `history`, `projects`, `shell-snapshots`, `todos`, `statsig`, `version`, unknown files | Never copied. |
| `.rly-overlay.json`, `.rly-manifest.json`, `.rly-reconcile.lock` | RLY metadata: allowlist marker, ownership manifest (categories + source paths + sha256 hashes only), and bounded per-view reconcile lock. |

Other pinned behaviors:

- Native `~/.claude/settings.json` (model key included), credentials, plugin metadata, history, and agent files are never rewritten by RLY; there is no post-exit restore of a saved global model (unsafe under concurrent sessions). The home-level `~/.claude.json` and project-local `.claude` are never touched.
- `/model` Enter/direct persistence writes into the owning profile view settings only; RLY session/history state under the view survives RLY launches; session-only `s` selection behaves normally. Another profile and a plain `claude` launch never inherit a profile's RLY-only model/gateway state.
- Typed ownership and precedence are deterministic (child-only RLY gateway contract env > RLY-owned persisted projection model > explicit RLY/profile launch-policy settings > user native settings/env > client persistence in the view > defaults); ownership wins over naive newer-mtime copy, and a conflicting native gateway/auth/model setting never overrides RLY's scoped launch contract silently.
- Refresh is deterministic and race-safe: unchanged native input is not rewritten (sibling `/model` writes survive); malformed native JSON surfaces are skipped; native deletions propagate only for owned imports that still match the imported hash (never unrelated RLY/view state, never additive-only ghosts).
- RLY gateway URL/token are child-env only and never persisted in view settings/history; no RLY credential secret enters a view or manifest.
- Migration: the legacy shared `~/.rly/claude` overlay moves into `views/default` exactly once (crash-safe two-phase sibling rename), never modifying native `~/.claude`; ambiguous shared persisted state stays in the unprofiled `default` view and is surfaced by `rly status`/`rly doctor`.
- If a future Claude Code client changes this layout, RLY must pin the new baseline through #24 before composing; unknown surfaces are never recursively copied.

## Gateway model discovery and projection (#72)

RLY exposes the configured, trusted model universe to Claude Code through the official Anthropic Messages gateway discovery surface on the **gateway listener** (`GET /v1/models`, same launch/gateway inference credentials as Messages requests):

| Area | Supported boundary behavior | Limits and readiness condition |
| --- | --- | --- |
| Discovery | `GET /v1/models` returns `{ data: [{ type: "model", id, display_name, created_at }], has_more, first_id, last_id }` with `limit` (1–100, default 20), `before_id`, and `after_id` pagination; ids are stable `claude-rly-<provider>-<hash>` handles | Pinned through #24 fixtures; the client's discovery filter only adds ids beginning with `claude`/`anthropic` (regression canary in tests) |
| Universe | Session tokens serve the session's pinned universe (policy revision/hash + registry revision + provider→pool bindings + experimental policy); the instance bearer serves the policy-derived universe | `VERIFIED` compatibility by default; `EXPERIMENTAL` only with `gateway.modelDiscovery.experimentalModels`; `BROKEN`/unreviewed/proposed never |
| Selection | A `claude-rly-*` model routes through the explicit reverse mapping to one exact access-provider/model target + pinned pool, then the #68/#70/account pipeline | Unknown/removed/BROKEN/ineligible ids fail closed (`model-unavailable`/`capability-rejected`); no silent substitution |
| Diagnostics | `route-trace` shows projection id/display name as allowlisted routing metadata plus the exact model/account decisions | No credentials, authorization headers, account identity, prompts, or responses |
| Child launch | RLY-launched Claude children receive child-only `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`; native settings cannot override it (overlay allowlist strips it); plain `claude` launches never inherit it | Parent/global environment unchanged |

**Exact `/model` targets vs portable tier aliases:** a discovered `/model` entry is one exact physical access-provider/model target. Logical tier aliases (`haiku`/`sonnet`/`opus`/`fable`) used by subagents/aliases resolve contextually through #69 and never equal a projected exact-model id. `display_name` labels are presentation-only (e.g. `GPT-5.6 Sol (Codex)` vs `GPT-5.6 Sol (ClinePass)`); routing uses only the reverse mapping, never the id/display strings.

## Canonical reasoning contract (#70)

Reasoning intent is a first-class canonical concern, separate from transport and
provider wire formats:

- **Canonical intent** (`src/core/reasoning.ts`): provider-neutral semantic
  intents `OFF` / `ECONOMY` / `BALANCED` / `DEEP` / `MAXIMUM` / `AUTO` plus
  source fidelity (`sourceMode`: `disabled`/`enabled`/`adaptive`, `sourceEffort`
  label, `explicit` flag). `CanonicalRequest.inference.reasoning` carries it;
  `inference.thinking` remains the legacy source-mode view.
- **Decoding** is based on the pinned supported-baseline shape
  (`tests/fixtures/upstream/claude-code/reasoning-shape.json`): Anthropic
  `thinking.type` continues to be accepted; the documented additive `effort`
  field (top-level or inside `thinking`) is preserved as `sourceEffort`;
  unknown additive fields stay recorded as ignored — never assumed. OpenAI
  Responses `reasoning.effort` is preserved instead of collapsed to a boolean.
  Deterministic intent derivation: explicit effort wins; else `enabled` →
  `BALANCED`, `adaptive` → `AUTO` + adaptive source mode, `disabled` → `OFF`;
  no signal → `AUTO` non-explicit.
- **Translation boundary** (`src/providers/reasoning.ts`): provider-owned,
  deterministic, no provider names and no LLM classification. `resolveReasoning(
  request, capability)` maps the canonical intent onto the selected model's
  `ReasoningCapabilityEvidence` control kind (discrete effort, binary, adaptive,
  token-budget, unsupported). Same-family exact source effort is preserved;
  fewer-level mappings pick the nearest reviewed native level; binary/adaptive
  controls never pretend effort granularity they do not have; token-budget
  mapping requires a reviewed per-model budget policy (never a universal
  hardcoded number). Every non-exact mapping returns `mappingKind`
  (`exact|normalized|downgraded|default`) plus a `fallbackReason`; explicit
  unsupported intents fail closed (`unsupported-reasoning`) unless an explicit
  best-effort policy enabled the recorded downgrade.
- **Adapter emission**: provider adapters own the exact native parameter.
  OpenAI-compatible adapters (OpenRouter/DeepSeek/Alibaba/OpenCode Go/Codex)
  emit `reasoning` from the translation result (`{enabled}` binary, `{enabled,
  effort}` discrete, `{enabled, max_tokens}` budget). The OpenRouter adapter no
  longer collapses `enabled`/`adaptive` into `{reasoning:{enabled:true}}`.
- **Diagnostics**: `/v1/route-traces` carries requested/canonical/effective
  reasoning metadata plus mapping kind and fallback reason. Reasoning **text**,
  prompts, responses, credentials, and account identity are never stored or
  logged.

## Logical model tiers (#69)

Portable agent definitions such as `model: fable` are supported as **logical
model tiers** — never as four globally fixed physical models:

- Canonical tiers: `haiku`, `sonnet`, `opus`, `fable`. They are typed separately
  from upstream model ids and resolved deterministically inside the current
  execution context: access provider first, then the parent model's upstream/
  model family when that provider exposes multiple families, then trusted
  capability evidence. `fable` means the configured/verified strongest tier for
  the current provider/family access path, not a global strongest-model search.
- Search order: explicit user mapping (`profile.modelRoles[tier]`) → reviewed
  default mapping → deterministic #68 candidate evaluation inside the same
  provider+family → explicitly enabled fallback scopes (cross-family within the
  provider, cross-provider with an explicit provider list). Cross-family or
  cross-provider substitution never occurs silently.
- Fail-closed: unknown tier, unknown family without parent context, no eligible
  same-family target, invalid override, or invalid reviewed mapping each
  produce a specific typed reason (`tier-unavailable` on the profile error
  contract plus `family-unknown`/`override-rejected`/`mapping-invalid` detail);
  RLY never substitutes another provider/model silently and never auto-activates
  proposed/unreviewed models (#23 boundary).
- The tier decision feeds #68 capability/compatibility validation and #70
  canonical reasoning, then the existing account pool selector; it never picks
  credentials/accounts directly and never emits provider-native fields such as
  `reasoning_effort`.
- Existing `primary`/`fast`/`reasoning` profile behavior is unchanged;
  `helper-map.ts` mappings are preserved. The supported Claude Code baseline's
  native `fable` alias behavior is classified by #24; a client without it is
  surfaced as incompatible rather than silently forced through a global override.

## Model intent and selector namespaces (#125)

The gateway separates the client-native alias vocabulary (owned by Claude/Codex)
from the RLY logical selector namespace before any routing. Core invariant:
**`fable != rly-tier:fable`**.

- **Selector namespaces**: `rly-tier:<tier>` is the explicit RLY logical-tier
  namespace (`rly-tier:haiku|sonnet|opus|fable`); `claude-rly-*` is the RLY
  projection namespace (#72); bare `haiku|sonnet|opus|fable` are client-native
  aliases; `inherit`/`default`/empty express inheritance/default intent; anything
  else is an exact client model id / profile role / helper alias. Classification
  is deterministic with documented precedence (explicit `rly-tier:` → projection
  → alias → inherit → default → exact model) and preserves the exact source
  selector for diagnostics.
- **Compatibility for existing selectors**: bare tier names in user agent/skill
  files or requests (e.g. `model: fable`) keep working without rewriting those
  files to physical provider model ids — they are classified as client-native
  aliases and mapped through the explicit, traceable client-alias contract to
  the equivalent RLY tier, then resolved by the #69 provider/family resolver.
  They are no longer RLY policy selectors by string equality: the trace records
  `kind: CLIENT_NATIVE_ALIAS` / `source: client-native-alias-contract`. An
  explicit `rly-tier:fable` is recorded as `kind: RLY_LOGICAL_TIER` / `source:
  rly-tier-namespace`. A selector that claims the RLY namespace with an unknown
  value fails closed (`unknown-namespace`) and is never reinterpreted.
- **Persisted exact model ids never become tiers**: a persisted profile/role
  value such as `gpt-5.6-sol` or `claude-sonnet-4-5` is classified as an exact
  client model and keeps the #68 exact path; `profile.modelRoles` tier keys
  (`haiku`/`sonnet`/`opus`/`fable`) keep their #69 meaning as per-profile user
  overrides. Ambiguous persisted values never silently change meaning.
- **Error/version gate**: the alias contract is part of the pinned supported
  baseline (see #24 fixtures above for `fable`/`haiku`/`sonnet`/`opus` alias
  semantics); classification failures surface typed reasons on the existing
  profile error contract. Diagnostics expose selector kind/source/resolved
  target only — never prompts, credentials, account identity, or settings
  contents.

## Native protocol rails and fidelity envelope (#119)

RLY is a protocol-preserving gateway first and a model router second. Three
separate authorities own the protocol boundary:

1. **Native protocol rail** — the encoder/decoder wire shapes (`src/protocols/
anthropic/`, `src/protocols/openai-responses/`) remain the source of wire truth
   for same-protocol traffic. RLY patches only RLY-owned controls (selected
   model, auth, endpoint).
2. **Semantic projection** — `CanonicalRequest` / `CanonicalEvent` stay the
   routing, capability, tool, reasoning-intent, diagnostics, and cross-protocol
   translation projection. Provider-specific opaque fields are not forced into
   semantic core types.
3. **Fidelity/continuation envelope** (`src/core/fidelity.ts`, version 1) —
   versioned metadata for source protocol/revision, typed opaque continuation
   artifacts (kind, stable item/block association, value), translation
   provenance (`preserved-native` / `translated` / `ignored` / `unsupported`),
   and the artifact kinds a compatibility claim requires. Adapters/codecs may
   preserve opaque artifacts; routing policy inspects only explicitly modeled
   safe metadata (kind, association, disposition), never artifact values.

| Area | Supported boundary behavior | Limits and readiness condition |
| --- | --- | --- |
| Anthropic thinking signatures | Assistant `thinking.signature` decodes into the fidelity envelope (`anthropic-thinking-signature`, association `message:block`) and is marked required when present; thinking text stays the semantic projection | The signature is preserved natively, never interpreted; a path that cannot represent a required signature fails closed |
| Streaming signature deltas | Canonical `signature-delta` events emit Anthropic `signature_delta` in valid order (after `thinking_delta`, before `content_block_stop`); the aggregator attaches the signature to the aggregate thinking block | A signature delta on a non-thinking block or before its content block fails closed (`invalid_event_order`); byte-level golden fixture pins the SSE |
| Responses reasoning identity + encrypted content | Reasoning item `id` survives on the semantic reasoning content; opaque `encrypted_content` rides the fidelity envelope (`openai-reasoning-encrypted-content`) and is required when present; continuation storage retains the exact artifact-to-item association and re-encode attaches each item's exact encrypted content | Opaque content is never reconstructed from summary text; association stays with the correct reasoning item across multi-turn continuation |
| Unknown additive fields | Recorded as `ignored` provenance notes (field + reason), on both protocols, and listed in `ignoredAdditiveFields` | Unknown required behavior still fails closed (`compatibility_unready` on Responses); an additive unknown is not silently treated as required continuation state |
| Cross-protocol fail-closed | A required artifact on a translation path that cannot preserve it fails with `unsupported-fidelity` before any upstream call (e.g. Chat Completions transport for OpenRouter/DeepSeek) | Nothing is fabricated, decrypted, or silently dropped; a request without required artifacts routes normally |
| Extension points | `OpaqueArtifactKind` is a typed union | Gemini thought signatures, OpenRouter reasoning details, DeepSeek reasoning continuation extend the envelope without redesigning canonical routing |

**Privacy invariant:** opaque artifact values are runtime/protocol state, not
diagnostics. They are never logged, never placed in route traces, and never
included in normal diagnostic bundles; `describeFidelity()` is the only
diagnostic surface and exposes provenance metadata (kinds, dispositions, field
names, counts) only. Continuation persistence applies the existing private-file
storage rules.

## Claude Code agent attribution and subagent model resolution (#71)

Claude Code sends runtime attribution headers on gateway requests; RLY uses
them to distinguish concurrent/nested subagent requests without inspecting
prompt content:

- **Ingress**: `X-Claude-Code-Session-Id`, `X-Claude-Code-Agent-Id`, and
  `X-Claude-Code-Parent-Agent-Id` are parsed at the Anthropic decoder into a
  typed `AgentContext` on the canonical request (`src/core/agent-context.ts`;
  case-insensitive, partial attribution allowed, empty/missing → no context).
  They are runtime attribution data, never authorization: authentication stays
  with RLY launch/gateway tokens.
- **Execution-context registry** (`src/profiles/agent-contexts.ts`): in-memory,
  lease-scoped; after a successful resolution each agent's context (launch
  binding, access provider, frozen physical model, model family, effective
  tier, mapping/registry revisions) is recorded; entries are valid only while
  the owning lease is active and are removed on lease revocation/expiry and
  runtime restart. Never stores credentials, account ids, or identity.
- **Parent-context resolution**: a subagent tier request resolves in its
  parent's execution context — exact `(session, parentAgentId)` match, then
  the session's main context, then the launch session's unambiguous
  profile-default model. The parent model/family feeds #69 tier resolution;
  when no parent/session family is determinable on a multi-family provider,
  resolution fails closed (`tier-unavailable` + `family-unknown` cause).
- **Routing**: the resolved tier target goes through #68 exact capability/
  compatibility validation and #70 reasoning translation, then the existing
  account pool for the frozen physical model. The parent/main session's model,
  profile mapping, and global Claude settings are never mutated; concurrent
  subagents resolve independently. Explicit subagent `effort` is preserved
  into the canonical reasoning request; a tool-using subagent with explicit
  reasoning demands `reasoningWithTools` evidence and fails closed otherwise.
- **No global override**: RLY never uses a global `CLAUDE_CODE_SUBAGENT_MODEL`
  or similar env that forces all subagents to one model; the source agent/skill
  definition (`model: fable`) is never rewritten to a physical model.
- **Diagnostics**: `/v1/route-traces` may carry allowlisted pseudonyms
  (sha256 hashes) for Claude session/agent/parent linkage plus the parent
  model/family used for tier resolution; never prompts, reasoning text,
  credentials, or durable user identity.
- The exact native `fable` alias behavior of a given Claude Code baseline is
  classified by #24 canary fixtures; the gated real-client E2E
  (`tests/e2e/claude-code/subagent-model.e2e.test.ts`, `RLY_CLAUDE_E2E=1`,
  skipped ≠ pass) pins the gateway plumbing on the observed local client.

## Runtime compatibility canary (#24 / BL-043)

The repository ships a runtime compatibility evidence gate (`src/canary/`, CLI `rly canary run|status`) that answers two separate questions and never collapses them:

1. **Client compatibility**: does this Claude Code / Codex CLI version still produce/consume the wire behavior RLY expects?
2. **Model access-path compatibility**: does this exact `(access provider, physical model, RLY adapter, client baseline)` support the runtime capabilities RLY claims?

- **Observed vs tested baseline**: `src/targets/versions.ts::probeClientVersion` reads the exact version from the client's own `--version` output (bounded timeout). Binary presence is `found`, never `compatible`; an unknown/newly installed version reports `unknown/not-tested` and never silently replaces the tested baseline. The pinned fixture baseline is `claude-code-2.1.229` (contract fixtures + overlay composition); the observed local client (2.1.231) and Codex `0.147.0-alpha.6.5` are recorded separately and are not tested baselines.
- **Pinned contract fixtures**: `tests/fixtures/upstream/claude-code/client-contract-2.1.229.json` (plus `model-discovery-shape.json`, `fable-subagent-shape.json`, `effort-signal-shape.json`, `streaming-framing.json`) and `tests/fixtures/upstream/codex/client-contract-observed.json` pin: session/agent/parent attribution headers; gateway `GET /v1/models` request/auth/response selection incl. the discovered-id prefix rule (`claude`/`anthropic`) and startup cache behavior; `fable`/`haiku`/`sonnet`/`opus` alias semantics; the subagent/session `effort` additive field; streaming framing; `--no-session-persistence`. A changed client contract fails the exact gate with a typed reason (`missing-agent-header`, `gateway-model-filter-changed`, `tool-result-invalid`, `reasoning-effort-clamped`, ...).
- **Gate matrix**: deterministic fake gates cover text, streaming, cancellation, single/multi/parallel tool loops, reasoning, reasoning+tools, model discovery, session attribution, subagent routing, parallel subagents, effort signal, and long-running-session behavior. Capability-dependent gates are `not-run` (never passed) when the access path lacks reviewed evidence, so a model that handles one tool call but fails multi-tool/continuation, or supports reasoning but fails reasoning+tools, is never advertised stronger than proven.
- **Classification**: `VERIFIED` requires every required gate for the advertised RLY use to pass AND live evidence where the provider class requires it (Codex OAuth, ClinePass, direct OpenRouter/DeepSeek all require live proof; a fake transport cannot prove a subscription/bridge path). Fake-only evidence is `EXPERIMENTAL` at most; a failed required contract is `BROKEN`; missing/unrun evidence is `unknown` and never reported as passed.
- **Evidence identity**: each result is keyed by exact client kind/version + access provider + adapter/integration mode + physical model (+ family when known). The same upstream model through two access providers never shares evidence.
- **Artifacts and handoff**: `rly canary run` persists secret-free, machine-readable evidence under `<control-plane>/canary/` and `rly canary status` prints tested baselines + per-path verdicts; artifacts are consumable by the #23/#67 review/proposal workflow and never mutate trusted registry evidence (`proposeCanaryState` reports drift only). `rly doctor` reports installed versions and the tested baseline.
- **#72 gating**: the projection gate consumes canary-derived compatibility state (`VERIFIED` default, `EXPERIMENTAL` opt-in, `BROKEN`/unreviewed never); live provider runs stay opt-in (`RLY_LIVE_CANARY=1`, skipped ≠ pass).
- **Privacy**: canary artifacts/logs carry client/provider/model ids, gate names, status, fixture revision, and redacted error categories only — never prompts, model responses, reasoning text, credentials, authorization headers, email, or account identity.

## Compatibility maintenance

Protocol drift starts with a redacted reproducing fixture. Any newly observed
field must be deliberately preserved, translated, or rejected before it is
listed here as supported. Provider-specific behavior belongs to the Phase 04
adapter/runtime route, not to this protocol boundary.

## Evidence

- Contract coverage: `tests/contract/anthropic/messages.test.ts`, `tests/contract/openai-responses/responses.test.ts`
- Fake-upstream route coverage: `tests/integration/fake-upstream/anthropic-route.test.ts`, `tests/integration/fake-upstream/openai-responses-route.test.ts`
- Codex launcher E2E: `tests/e2e/codex/fake-upstream.e2e.test.ts`
- ClinePass Claude profile: `tests/lifecycle/cline-profile-route.test.ts`, `tests/e2e/claude-code/cline-interop.e2e.test.ts` (gated `RLY_CLAUDE_E2E=1`; skipped ≠ pass)
- Boundary code: `src/protocols/anthropic/`, `src/protocols/openai-responses/`, `src/routes/anthropic-*.ts`, `src/routes/openai-responses-route.ts`
