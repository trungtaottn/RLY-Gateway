import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { assertSecretFree } from "../../src/control-plane/secret-free.js";
import { parseProviderError, translateProviderError } from "../../src/providers/provider-error.js";
import { providerErrorPayload, providerErrorStatus, providerRetryAfterOf } from "../../src/routes/provider-error-mapping.js";
import { retryReasonOf, retryTrace, isAllowedRetryTraceKey } from "../../src/observability/retry-trace.js";
import { ProviderAdapterError } from "../../src/providers/provider-adapter.js";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/decoder.js";
import { decideRoute, type RouteRecord } from "../../src/core/router.js";
import { registerOpenAiResponsesRoute } from "../../src/routes/openai-responses-route.js";
import { OpenRouterAdapter } from "../../src/providers/direct/openrouter-adapter.js";

const capabilities = { streaming: true, tools: true, parallelTools: false, images: false, reasoning: true, redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate" as const };
const route: RouteRecord = { role: "primary", providerId: "openrouter", modelId: "fixture-model", adapterId: "openrouter-direct", credentialRef: { kind: "env", name: "OPENROUTER_API_KEY" }, capabilities };

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A deliberately secret-bearing provider error body — must never survive parsing. */
const SECRET_BEARING_BODY = {
  error: {
    code: "invalid_request_error",
    type: "invalid_request_error",
    message: "synthetic provider message",
    param: "model",
    authorization: "Bearer real-token-value",
    apiKey: "sk-real-key-value",
    credential: "cred-real-value",
    accountId: "acct-real-identity",
    raw_response: "full provider response with private reasoning text",
  },
};

describe("error/retry observability privacy (#121)", () => {
  it("parseProviderError keeps only allowlisted fields — never credentials, raw bodies, or identity", async () => {
    const response = new Response(JSON.stringify(SECRET_BEARING_BODY), { status: 400, headers: { "retry-after": "12", "x-ratelimit-limit": "10", "x-ratelimit-remaining": "9" } });
    const info = await parseProviderError(response);
    expect(info).toEqual({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: "synthetic provider message",
      param: "model",
      retryAfterSeconds: 12,
      rateLimit: { limit: 10, remaining: 9, resetSeconds: 12 },
    });
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain("real-token");
    expect(serialized).not.toContain("real-key");
    expect(serialized).not.toContain("real-identity");
    expect(serialized).not.toContain("private reasoning text");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("apiKey");
    assertSecretFree(info);
  });

  it("parseProviderError falls back to a bounded generic message for unparseable bodies", async () => {
    const response = new Response("<html>proxy error with <secret>value</secret></html>", { status: 502 });
    const info = await parseProviderError(response);
    expect(info.code).toBe("api_error");
    expect(info.message).toBe("Provider request failed (HTTP 502)");
    expect(info.message.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(info)).not.toContain("secret");
  });

  it("client-facing error payloads carry translated safe fields only", () => {
    const error = new ProviderAdapterError(
      "rate_limit_error",
      "Rate limited (synthetic).",
      { statusCode: 429, code: "rate_limit_error", message: "Rate limited (synthetic).", retryAfterSeconds: 45 },
      "not-sent",
    );
    expect(providerErrorPayload(error, "openai-responses")).toEqual({ type: "rate_limit_error", code: "rate_limit_error", message: "Rate limited (synthetic)." });
    expect(providerErrorStatus(error, "openai-responses")).toBe(429);
    expect(providerRetryAfterOf(error)).toBe(45);
    const anthropic = translateProviderError(error.info as NonNullable<typeof error.info>, "anthropic-messages");
    expect(anthropic).toMatchObject({ statusCode: 429, code: "rate_limit_error", retryAfterSeconds: 45 });
    assertSecretFree(providerErrorPayload(error, "openai-responses"));
  });

  it("retry traces have a fixed allowlisted key set and never content", () => {
    const trace = retryTrace({
      requestId: "req-1",
      providerId: "openrouter",
      adapterId: "openrouter-direct",
      modelId: "fixture-model",
      attempt: 2,
      commitment: "provider-accepted",
      statusCode: 502,
      retryable: false,
      retryReason: "commitment-past-not-sent",
      terminalReason: "provider-failed",
      outcome: "transient",
    });
    expect(Object.keys(trace).sort()).toEqual([
      "adapterId", "attempt", "commitment", "modelId", "outcome", "providerId", "requestId", "retryReason", "retryable", "statusClass", "terminalReason",
    ]);
    for (const key of Object.keys(trace)) expect(isAllowedRetryTraceKey(key)).toBe(true);
    expect(JSON.stringify(trace)).not.toContain("prompt");
    expect(JSON.stringify(trace)).not.toContain("Bearer");
    expect(JSON.stringify(trace)).not.toContain("token");
    assertSecretFree(trace);
  });

  it("retryReasonOf classifies failures from safe metadata only", () => {
    const error = new ProviderAdapterError("api_error", "synthetic", undefined, "unknown");
    expect(retryReasonOf(error)).toMatchObject({ retryable: false, reason: "commitment-past-not-sent", commitment: "unknown" });
    const notSent = new ProviderAdapterError("authentication_error", "synthetic", { statusCode: 401, code: "authentication_error", message: "synthetic" }, "not-sent");
    expect(retryReasonOf(notSent)).toMatchObject({ retryable: true, reason: "deterministic-rejection", statusCode: 401 });
    expect(JSON.stringify(retryReasonOf(notSent))).not.toContain("synthetic credential");
  });

  it("route error responses never leak provider body secrets", async () => {
    const decoded = decodeResponsesRequest({ model: "fixture-model", input: "fixture" });
    const secretBody = { error: { code: "authentication_error", message: "Bad key (synthetic).", authorization: "Bearer real-token", prompt: "private prompt" } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(secretBody), { status: 401 }));
    const upstream = {
      invoke: (_ignored: unknown, signal: AbortSignal) => new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" }).invoke(decoded.request, decideRoute({ requestId: decoded.request.id, route, required: [], configFingerprint: "a".repeat(64) }), signal),
    };
    app = Fastify();
    registerOpenAiResponsesRoute(app, { route, configFingerprint: "a".repeat(64), upstream });
    const response = await app.inject({ method: "POST", url: "/v1/responses", payload: { model: "fixture-model", input: "fixture" } });
    expect(response.statusCode).toBe(401);
    const body = response.json<{ error: { type?: string; message?: string; authorization?: string; prompt?: string } }>();
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toBe("Bad key (synthetic).");
    expect(JSON.stringify(body)).not.toContain("real-token");
    expect(JSON.stringify(body)).not.toContain("private prompt");
    expect(JSON.stringify(body)).not.toContain("fixture-secret");
  });
});
