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
  the activated profile's model-role map.
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

## Claude configuration overlay (#74)

RLY-launched Claude sessions do not use a throwaway `CLAUDE_CONFIG_DIR` temp
directory. The launcher (`src/cli/main.ts`) prepares a durable RLY-owned
overlay (`<control-plane>/claude`, `~/.rly/claude` by default) with
[`src/runtime/claude-overlay.ts`](../src/runtime/claude-overlay.ts) and passes
it as the child `CLAUDE_CONFIG_DIR`. The native user config root is composed
as read-only input through a typed allowlist. `CLAUDE_CONFIG_DIR` layout pinned
for the supported baseline (currently observed `2.1.229`, fixtures owned by
#24):

| Surface | RLY composition |
| --- | --- |
| `settings.json` | One-way merge: unrelated keys and native `model` preserved; `env` keys conflicting with the RLY gateway contract (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `CODEX_HOME`, `CODEX_API_KEY`) stripped; a persisted RLY-only `claude-rly-*` model is RLY-owned and wins on re-compose. Written only in the overlay. |
| `agents/*.md`, `commands/*.md` | One-way refresh copy when missing or native is newer. |
| `skills/**` | Allowlisted recursive copy of user-authored skills (`node_modules`, `.git` excluded; symlinks never followed). |
| `plugins/config.json` | Only `enabledPlugins`/`marketplaces` carried; `oauthAccounts`/token-like keys and plugin cache/repos never copied (plugin runtime state stays native). |
| `history`, `projects`, `shell-snapshots`, `todos`, `statsig`, `version`, unknown files | Never copied. |

Other pinned behaviors:

- Native `~/.claude/settings.json` (model key included), credentials, plugin metadata, history, and agent files are never rewritten by RLY; there is no post-exit restore of a saved global model (unsafe under concurrent sessions). The home-level `~/.claude.json` and project-local `.claude` are never touched.
- `/model` Enter/direct persistence writes into the overlay settings only; RLY session/history state under the overlay survives RLY launches; session-only `s` selection behaves normally.
- Refresh is deterministic and race-safe: unchanged native input is not rewritten (sibling `/model` writes survive); native deletions are not propagated; malformed native JSON surfaces are skipped.
- RLY gateway URL/token are child-env only and never persisted in overlay settings/history; no RLY credential secret enters the overlay.
- If a future Claude Code client changes this layout, RLY must pin the new baseline through #24 before composing; unknown surfaces are never recursively copied.

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
