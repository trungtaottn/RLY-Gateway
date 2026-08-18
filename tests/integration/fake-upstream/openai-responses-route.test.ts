import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRecord } from "../../../src/core/router.js";
import { FakeCanonicalUpstream } from "../../../src/protocols/anthropic/fake-upstream.js";
import { ResponseContinuationStore } from "../../../src/protocols/openai-responses/continuation.js";
import { registerOpenAiResponsesRoute } from "../../../src/routes/openai-responses-route.js";

let app: FastifyInstance | undefined;
const directories: string[] = [];
const route: RouteRecord = {
  role: "primary",
  providerId: "fake",
  modelId: "fixture-model",
  adapterId: "fake",
  credentialRef: { kind: "env", name: "OPENROUTER_API_KEY" },
  capabilities: { streaming: true, tools: true, parallelTools: false, images: false, reasoning: true, redactedReasoning: false, structuredOutput: false, tokenCounting: "exact-local" },
};

afterEach(async () => {
  await app?.close();
  app = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OpenAI Responses fake upstream route", () => {
  it("rejects unavailable required features before invoking upstream", async () => {
    app = Fastify();
    registerOpenAiResponsesRoute(app, { route: { ...route, capabilities: { ...route.capabilities, tools: false } }, configFingerprint: "a".repeat(64), upstream: new FakeCanonicalUpstream() });
    const response = await app.inject({ method: "POST", url: "/v1/responses", payload: { model: "fixture-model", input: "fixture", tools: [{ type: "function", name: "fixture_tool" }] } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ type: "error", error: { type: "unsupported_feature", message: "Request requires an unavailable capability" } });
  });

  it("serves streaming, non-streaming, and continuation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-responses-route-"));
    directories.push(directory);
    app = Fastify();
    registerOpenAiResponsesRoute(app, {
      route,
      configFingerprint: "a".repeat(64),
      upstream: new FakeCanonicalUpstream(),
      continuation: new ResponseContinuationStore(directory),
    });
    const stream = await app.inject({ method: "POST", url: "/v1/responses", payload: { model: "fixture-model", input: "fixture", stream: true } });
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toContain("response.output_text.delta");
    const complete = await app.inject({ method: "POST", url: "/v1/responses", payload: { model: "fixture-model", input: "fixture" } });
    expect(complete.json()).toMatchObject({ object: "response", output: [{ type: "message" }] });
    const continued = await app.inject({ method: "POST", url: "/v1/responses", payload: { model: "fixture-model", previous_response_id: "msg_fake", input: "next fixture" } });
    expect(continued.statusCode).toBe(200);
    const stored = await app.inject({ method: "GET", url: "/v1/responses/msg_fake" });
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toMatchObject({ id: "msg_fake", object: "response", model: "fixture-model" });
    const missing = await app.inject({ method: "GET", url: "/v1/responses/resp_missing" });
    expect(missing.statusCode).toBe(404);
  });

  it("fails closed on unknown required lifecycle items", async () => {
    app = Fastify();
    registerOpenAiResponsesRoute(app, { route, configFingerprint: "a".repeat(64), upstream: new FakeCanonicalUpstream() });
    const response = await app.inject({ method: "POST", url: "/v1/responses", payload: { model: "fixture-model", input: [{ type: "mcp_call" }] } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { type: "compatibility_unready" } });
  });

  it("does not persist the response when store is false, streaming or not (#J3)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-responses-store-"));
    directories.push(directory);
    app = Fastify();
    registerOpenAiResponsesRoute(app, {
      route,
      configFingerprint: "a".repeat(64),
      upstream: new FakeCanonicalUpstream(),
      continuation: new ResponseContinuationStore(directory),
    });
    // Non-streaming with store:false — the response is served but NOT stored.
    // (FakeCanonicalUpstream deterministically responds with id `msg_fake`.)
    const complete = await app.inject({ method: "POST", url: "/v1/responses", payload: { model: "fixture-model", input: "fixture", store: false } });
    expect(complete.statusCode).toBe(200);
    const missing = await app.inject({ method: "GET", url: "/v1/responses/msg_fake" });
    expect(missing.statusCode).toBe(404);
    // Streaming with store:false — same intent honored on the stream path.
    const stream = await app.inject({ method: "POST", url: "/v1/responses", payload: { model: "fixture-model", input: "fixture", stream: true, store: false } });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain("response.completed");
    const stored = await app.inject({ method: "GET", url: "/v1/responses/msg_fake" });
    expect(stored.statusCode).toBe(404);
    // Control: the default (store unset) still persists — regression guard.
    const kept = await app.inject({ method: "POST", url: "/v1/responses", payload: { model: "fixture-model", input: "fixture" } });
    expect(kept.statusCode).toBe(200);
    const found = await app.inject({ method: "GET", url: "/v1/responses/msg_fake" });
    expect(found.statusCode).toBe(200);
  });
});
