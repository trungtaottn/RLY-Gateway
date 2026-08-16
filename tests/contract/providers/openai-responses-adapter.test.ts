import { describe, expect, it, vi } from "vitest";
import type { CanonicalEvent } from "../../../src/core/canonical-event.js";
import { decideRoute, type RouteRecord } from "../../../src/core/router.js";
import { decodeResponsesRequest } from "../../../src/protocols/openai-responses/decoder.js";
import { OpenRouterAdapter } from "../../../src/providers/direct/openrouter-adapter.js";
import { ProviderAdapterError } from "../../../src/providers/provider-adapter.js";
import { emptyFidelityEnvelope, withRequired } from "../../../src/core/fidelity.js";

const capabilities = { streaming: true, tools: true, parallelTools: false, images: false, reasoning: true, redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate" as const };
const route: RouteRecord = { role: "primary", providerId: "openrouter", modelId: "fixture-model", adapterId: "openrouter-direct", credentialRef: { kind: "env", name: "OPENROUTER_API_KEY" }, capabilities };

function decision(requestId: string) {
  return decideRoute({ requestId, route, required: [], configFingerprint: "a".repeat(64) });
}

function sse(frames: ReadonlyArray<{ event: string; data: unknown }>): string {
  return frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join("");
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

const streamStart = { event: "response.created", data: { type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress", model: "fixture-model", output: [], usage: {} } } };
const textItem = { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_provider", role: "assistant", status: "in_progress", content: [] } } };
const textDelta = { event: "response.output_text.delta", data: { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hello " } };
const textDelta2 = { event: "response.output_text.delta", data: { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "world" } };
const itemDone = { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0 } };
const completed = { event: "response.completed", data: { type: "response.completed", response: { id: "resp_1", object: "response", status: "completed", model: "fixture-model", output: [], usage: { input_tokens: 3, output_tokens: 2 } } } };

describe("OpenAI Responses native upstream rail (#121)", () => {
  it("uses the native /responses endpoint for same-protocol Requests", async () => {
    const decoded = decodeResponsesRequest({ model: "fixture-model", input: "fixture", stream: true });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse([streamStart, textItem, textDelta, textDelta2, itemDone, completed]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    const events = await collect(adapter.invoke(decoded.request, decision(decoded.request.id), new AbortController().signal));
    expect(fetch.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/responses");
    const outbound = fetch.mock.calls[0]?.[1]?.body;
    expect(typeof outbound === "string" ? outbound : "").not.toContain("fixture-secret");
    const payload = typeof outbound === "string" ? JSON.parse(outbound) as Record<string, unknown> : {};
    expect(payload).toMatchObject({ model: "fixture-model", stream: true });
    expect(payload.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "fixture" }] }]);
    expect(events.map((item) => item.type)).toEqual([
      "response-started", "content-started", "text-delta", "text-delta", "content-completed", "usage-updated", "response-completed",
    ]);
    // Provider item identity survives.
    expect((events.find((item) => item.type === "content-started") as { itemId?: string }).itemId).toBe("msg_provider");
  });

  it("decodes streaming tool calls with provider item ids and call ids", async () => {
    const decoded = decodeResponsesRequest({ model: "fixture-model", input: "fixture", stream: true, tools: [{ type: "function", name: "fixture_tool" }] });
    const frames = [
      streamStart,
      { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_provider", call_id: "call_provider", name: "fixture_tool", arguments: "" } } },
      { event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_provider", delta: "{\"value\":" } },
      { event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_provider", delta: "1}" } },
      { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0 } },
      { event: "response.completed", data: { type: "response.completed", response: { id: "resp_1", object: "response", status: "completed", model: "fixture-model", output: [], usage: {} } } },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    const events = await collect(adapter.invoke(decoded.request, decision(decoded.request.id), new AbortController().signal));
    const started = events.find((item): item is Extract<CanonicalEvent, { type: "content-started" }> => item.type === "content-started" && item.contentType === "tool-call");
    expect(started).toMatchObject({ toolCallId: "call_provider", toolName: "fixture_tool", itemId: "fc_provider" });
    const args = events.filter((item) => item.type === "tool-arguments-delta").map((item) => (item as { partialJson: string }).partialJson).join("");
    expect(args).toBe('{"value":1}');
  });

  it("preserves 429 rate-limit metadata with retry-after and not-sent commitment", async () => {
    const decoded = decodeResponsesRequest({ model: "fixture-model", input: "fixture" });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "rate_limit_error", message: "Rate limited (synthetic).", param: null, type: "rate_limit_error" } }), { status: 429, headers: { "retry-after": "45", "x-ratelimit-limit": "500", "x-ratelimit-remaining": "0" } }));
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    let error: unknown;
    try { await collect(adapter.invoke(decoded.request, decision(decoded.request.id), new AbortController().signal)); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ProviderAdapterError);
    const providerError = error as ProviderAdapterError;
    expect(providerError.code).toBe("rate_limit_error");
    expect(providerError.commitment).toBe("not-sent");
    expect(providerError.info).toMatchObject({ statusCode: 429, retryAfterSeconds: 45, rateLimit: { limit: 500, remaining: 0 } });
    expect(providerError.message).toBe("Rate limited (synthetic).");
  });

  it("classifies 5xx as ambiguous (unknown) — no replay", async () => {
    const decoded = decodeResponsesRequest({ model: "fixture-model", input: "fixture" });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Internal error (synthetic)." } }), { status: 503 }));
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    let error: unknown;
    try { await collect(adapter.invoke(decoded.request, decision(decoded.request.id), new AbortController().signal)); } catch (caught) { error = caught; }
    expect((error as ProviderAdapterError).commitment).toBe("unknown");
  });

  it("classifies connection-level failures as not-sent and generic transport failures as unknown", async () => {
    const decoded = decodeResponsesRequest({ model: "fixture-model", input: "fixture" });
    const refused = new TypeError("fetch failed");
    (refused as { cause?: { code?: string } }).cause = { code: "ECONNREFUSED" };
    const generic = new TypeError("fetch failed");
    const adapter = new OpenRouterAdapter(vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(refused), undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    let first: unknown;
    try { await collect(adapter.invoke(decoded.request, decision(decoded.request.id), new AbortController().signal)); } catch (caught: unknown) { first = caught; }
    expect(first).toBeInstanceOf(ProviderAdapterError);
    if (first instanceof ProviderAdapterError) expect(first.commitment).toBe("not-sent");
    const adapter2 = new OpenRouterAdapter(vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(generic), undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    let second: unknown;
    try { await collect(adapter2.invoke(decoded.request, decision(decoded.request.id), new AbortController().signal)); } catch (caught: unknown) { second = caught; }
    expect(second).toBeInstanceOf(ProviderAdapterError);
    if (second instanceof ProviderAdapterError) expect(second.commitment).toBe("unknown");
  });

  it("fails closed when the native rail cannot represent a required Anthropic artifact", async () => {
    // An Anthropic thinking signature is required, but the Responses rail
    // cannot represent it → unsupported-fidelity before any upstream call.
    const decoded = decodeResponsesRequest({ model: "fixture-model", input: "fixture" });
    const request = decoded.request;
    const fidelity = withRequired(emptyFidelityEnvelope("anthropic-messages"), ["anthropic-thinking-signature"]);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    let error: unknown;
    try { await collect(adapter.invoke({ ...request, fidelity }, decision(request.id), new AbortController().signal)); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect((error as ProviderAdapterError).code).toBe("unsupported-fidelity");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("probes models on the same base endpoint and reports readiness", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }), { status: 200 }));
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    const probe = await adapter.probe(decision("probe"), new AbortController().signal);
    expect(probe).toMatchObject({ readiness: "ready", modelId: "fixture-model" });
    expect(fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", expect.any(Object));
  });
});
