import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAnthropicMessagesRoute } from "../../../src/routes/anthropic-messages-route.js";
import { registerAnthropicCountTokensRoute } from "../../../src/routes/anthropic-count-tokens-route.js";
import { FakeCanonicalUpstream, collectWithSafeRetry, RetryableTransportError, type CanonicalUpstream } from "../../../src/protocols/anthropic/fake-upstream.js";
import type { RouteRecord } from "../../../src/core/router.js";

let app: FastifyInstance | undefined;
const route: RouteRecord = { role: "primary", providerId: "fake", modelId: "fixture-model", adapterId: "fake", credentialRef: { kind: "env", name: "OPENROUTER_API_KEY" }, capabilities: { streaming: true, tools: true, parallelTools: false, images: false, reasoning: false, redactedReasoning: false, structuredOutput: false, tokenCounting: "exact-local" } };
const body = { model: "fixture-model", max_tokens: 10, messages: [{ role: "user", content: "fixture" }] };
afterEach(async () => { await app?.close(); app = undefined; });

describe("Anthropic fake upstream route", () => {
  it("rejects unavailable required features before invoking upstream", async () => {
    app = Fastify(); const invoke = new FakeCanonicalUpstream().invoke.bind(new FakeCanonicalUpstream());
    registerAnthropicMessagesRoute(app, { route, configFingerprint: "a".repeat(64), upstream: { invoke } });
    const response = await app.inject({ method: "POST", url: "/v1/messages", payload: { ...body, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } }] }] } });
    expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ type: "error", error: { type: "unsupported_feature", message: "Request requires an unavailable capability" } });
  });

  it("serves streaming and declared count quality", async () => {
    app = Fastify(); const upstream = new FakeCanonicalUpstream("tool");
    registerAnthropicMessagesRoute(app, { route: { ...route, capabilities: { ...route.capabilities, images: true } }, configFingerprint: "a".repeat(64), upstream }); registerAnthropicCountTokensRoute(app, upstream);
    const stream = await app.inject({ method: "POST", url: "/v1/messages", payload: { ...body, stream: true } });
    expect(stream.headers["content-type"]).toContain("text/event-stream"); expect(stream.body).toContain("input_json_delta");
    const count = await app.inject({ method: "POST", url: "/v1/messages/count_tokens", payload: body });
    expect(count.headers["x-agent-gateway-token-count-quality"]).toBe("exact-local"); expect(count.json()).toEqual({ input_tokens: 12 });
  });

  it("retries only a pre-first-byte transport failure", async () => {
    const decoded = (await import("../../../src/protocols/anthropic/decoder.js")).decodeAnthropicRequest(body);
    let calls = 0; const retryable: CanonicalUpstream = { async *invoke(request) { calls += 1; if (calls === 1) throw new RetryableTransportError(); yield* new FakeCanonicalUpstream().invoke(request, new AbortController().signal); } };
    await expect(collectWithSafeRetry(retryable, decoded.request, new AbortController().signal)).resolves.toHaveLength(6); expect(calls).toBe(2);
  });

  it("does not retry non-transport errors or override unsupported token counting", async () => {
    const decoded = (await import("../../../src/protocols/anthropic/decoder.js")).decodeAnthropicRequest(body);
    let calls = 0; const failing: CanonicalUpstream = { async *invoke() { calls += 1; await Promise.resolve(); throw new Error("provider error"); yield undefined as never; } };
    await expect(collectWithSafeRetry(failing, decoded.request, new AbortController().signal)).rejects.toThrow("provider error"); expect(calls).toBe(1);
    app = Fastify(); const upstream = new FakeCanonicalUpstream(); registerAnthropicCountTokensRoute(app, upstream, { ...route, capabilities: { ...route.capabilities, tokenCounting: "unsupported" } });
    const count = await app.inject({ method: "POST", url: "/v1/messages/count_tokens", payload: body }); expect(count.statusCode).toBe(501);
  });

});
