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
- OpenAI Responses has canonical type identity reserved, but no runtime
  decoder, encoder, or Codex CLI integration.

## Compatibility maintenance

Protocol drift starts with a redacted reproducing fixture. Any newly observed
field must be deliberately preserved, translated, or rejected before it is
listed here as supported. Provider-specific behavior belongs to the Phase 04
adapter/runtime route, not to this protocol boundary.

## Evidence

- Contract coverage: `tests/contract/anthropic/messages.test.ts`
- Fake-upstream route coverage: `tests/integration/fake-upstream/anthropic-route.test.ts`
- Boundary code: `src/protocols/anthropic/` and `src/routes/anthropic-*.ts`
