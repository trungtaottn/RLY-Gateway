import { describe, expect, it, vi } from "vitest";
import { decodeAnthropicRequest } from "../../../src/protocols/anthropic/decoder.js";
import { DeepSeekAdapter } from "../../../src/providers/direct/deepseek-adapter.js";
import { OpenRouterAdapter } from "../../../src/providers/direct/openrouter-adapter.js";
import { decideRoute, type RouteRecord } from "../../../src/core/router.js";
import type { CanonicalEvent } from "../../../src/core/canonical-event.js";

const capabilities = { streaming: true, tools: true, parallelTools: false, images: true, reasoning: true, redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate" as const };
const baseRoute: RouteRecord = { role: "primary", providerId: "openrouter", modelId: "fixture-model", adapterId: "openrouter-direct", credentialRef: { kind: "env", name: "OPENROUTER_API_KEY" }, capabilities };
const body = { model: "primary", max_tokens: 42, messages: [{ role: "user", content: "fixture" }], tools: [{ name: "fixture_tool", input_schema: { type: "object" } }] };

function decision(route = baseRoute) {
  return decideRoute({ requestId: "request-fixture", route, required: [], configFingerprint: "a".repeat(64) });
}

describe("direct provider adapters", () => {
  it("resolves an OpenRouter reference only for the outbound request and preserves text/tool/usage", async () => {
    const request = decodeAnthropicRequest(body).request;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "chat_fixture", choices: [{ finish_reason: "tool_calls", message: { content: "fixture text", tool_calls: [{ id: "call_fixture", function: { name: "fixture_tool", arguments: "{\"value\":1}" } }] } }], usage: { prompt_tokens: 8, completion_tokens: 3 } }), { status: 200 }));
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    const events: CanonicalEvent[] = [];
    for await (const item of adapter.invoke(request, decision(), new AbortController().signal)) events.push(item);
    const outboundOptions = fetch.mock.calls[0]?.[1];
    expect(fetch.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(outboundOptions?.headers).toMatchObject({ authorization: "Bearer fixture-secret" });
    expect(events.map((item) => item.type)).toEqual(["response-started", "content-started", "text-delta", "content-completed", "content-started", "tool-arguments-delta", "content-completed", "usage-updated", "response-completed"]);
    expect(events.at(-2)).toMatchObject({ type: "usage-updated", inputTokens: 8, outputTokens: 3 });
    const outbound = fetch.mock.calls[0]?.[1]?.body;
    expect(typeof outbound === "string" ? outbound : "").not.toContain("fixture-secret");
  });

  it("replays DeepSeek reasoning_content only with its prior assistant tool call", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = new DeepSeekAdapter(fetch, undefined, { DEEPSEEK_API_KEY: "fixture-secret" });
    const request = decodeAnthropicRequest({ ...body, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "fixture reasoning" }, { type: "tool_use", id: "call_fixture", name: "fixture_tool", input: { value: 1 } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_fixture", content: "fixture result" }] }] }).request;
    const payload = (adapter as unknown as { payload: (value: typeof request) => { messages: { role: string; reasoning_content?: string }[] } }).payload(request);
    expect(payload.messages.find((message) => message.role === "assistant")).toMatchObject({ reasoning_content: "fixture reasoning" });
    const openRouter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    const openRouterPayload = (openRouter as unknown as { payload: (value: typeof request) => { messages: { role: string; reasoning_content?: string }[] } }).payload(request);
    expect(openRouterPayload.messages.find((message) => message.role === "assistant")).not.toHaveProperty("reasoning_content");
  });

  it("maps an Anthropic thinking request to OpenRouter reasoning without changing the core request", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    const request = decodeAnthropicRequest({ ...body, thinking: { type: "enabled" } }).request;
    const payload = (adapter as unknown as { payload: (value: typeof request) => Record<string, unknown> }).payload(request);
    expect(payload.reasoning).toEqual({ enabled: true });
  });

  it("probes without changing config/registry and reports unauthenticated state", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response("{}", { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "other-model" }] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }), { status: 200 }));
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    await expect(adapter.probe(decision(), new AbortController().signal)).resolves.toMatchObject({ readiness: "unauthenticated" });
    await expect(adapter.probe(decision(), new AbortController().signal)).resolves.toMatchObject({ readiness: "unavailable" });
    await expect(adapter.probe(decision(), new AbortController().signal)).resolves.toMatchObject({ providerId: "openrouter", modelId: "fixture-model", readiness: "ready", capabilities });
    expect(fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", expect.any(Object));
  });

  it("buffers split tool arguments until the tool name arrives", async () => {
    const request = decodeAnthropicRequest({ ...body, stream: true }).request;
    const sse = [
      'data: {"id":"fixture","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_fixture","function":{"arguments":"{\\"value\\":"}}]}}]}',
      'data: {"id":"fixture","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"fixture_tool","arguments":"\\"ok\\"}"}}]}}]}',
      'data: {"id":"fixture","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
      "data: [DONE]",
    ].join("\n\n");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    const events: CanonicalEvent[] = [];
    for await (const item of adapter.invoke(request, decision(), new AbortController().signal)) events.push(item);
    expect(events.map((item) => item.type)).toEqual(["response-started", "content-started", "tool-arguments-delta", "tool-arguments-delta", "usage-updated", "content-completed", "response-completed"]);
  });

  it("bounds a stalled provider fetch without treating client cancellation as a timeout", async () => {
    const request = decodeAnthropicRequest(body).request;
    const fetch = vi.fn<typeof globalThis.fetch>((_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" }, 1);
    await expect(async () => {
      for await (const _ of adapter.invoke(request, decision(), new AbortController().signal)) { void _; }
    }).rejects.toMatchObject({ code: "api_error", message: "Provider request timed out" });
  });
});
