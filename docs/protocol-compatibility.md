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
| Token counting | Direct routes use an explicit conservative estimate or `501` when declared unsupported | Quality is sent in `x-agent-gateway-token-count-quality`; no provider tokenizer parity is claimed without adapter evidence. |
| Retry and cancellation | Non-stream collection retries once only when a transport error occurs before any canonical event. Client abort is propagated to the route upstream signal. | Streaming retry, real-provider cancellation, and backpressure still require Phase 04/provider-runtime evidence. |

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

## Compatibility maintenance

Protocol drift starts with a redacted reproducing fixture. Any newly observed
field must be deliberately preserved, translated, or rejected before it is
listed here as supported. Provider-specific behavior belongs to the Phase 04
adapter/runtime route, not to this protocol boundary.

## Evidence

- Contract coverage: `tests/contract/anthropic/messages.test.ts`, `tests/contract/openai-responses/responses.test.ts`
- Fake-upstream route coverage: `tests/integration/fake-upstream/anthropic-route.test.ts`, `tests/integration/fake-upstream/openai-responses-route.test.ts`
- Codex launcher E2E: `tests/e2e/codex/fake-upstream.e2e.test.ts`
- Boundary code: `src/protocols/anthropic/`, `src/protocols/openai-responses/`, `src/routes/anthropic-*.ts`, `src/routes/openai-responses-route.ts`
