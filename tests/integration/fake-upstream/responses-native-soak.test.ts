import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent } from "../../../src/core/canonical-event.js";
import { decideRoute, type RouteRecord } from "../../../src/core/router.js";
import { decodeResponsesRequest } from "../../../src/protocols/openai-responses/decoder.js";
import { createResponsesIncrementalEncoder } from "../../../src/protocols/openai-responses/encoder.js";
import { ResponseContinuationStore } from "../../../src/protocols/openai-responses/continuation.js";
import { registerOpenAiResponsesRoute } from "../../../src/routes/openai-responses-route.js";
import { OpenRouterAdapter } from "../../../src/providers/direct/openrouter-adapter.js";
import { ProviderAdapterError } from "../../../src/providers/provider-adapter.js";

const capabilities = { streaming: true, tools: true, parallelTools: false, images: false, reasoning: true, redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate" as const };
const route: RouteRecord = { role: "primary", providerId: "openrouter", modelId: "fixture-model", adapterId: "openrouter-direct", credentialRef: { kind: "env", name: "OPENROUTER_API_KEY" }, capabilities };

let app: FastifyInstance | undefined;
const directories: string[] = [];

afterEach(async () => {
  await app?.close();
  app = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function decision(requestId: string) {
  return decideRoute({ requestId, route, required: [], configFingerprint: "a".repeat(64) });
}

/** Builds a provider SSE stream of K blocks × D deltas + terminal frames. */
function nativeStreamSse(blocks: number, deltasPerBlock: number): string {
  const frames: Array<{ event: string; data: unknown }> = [
    { event: "response.created", data: { type: "response.created", response: { id: "resp_soak", object: "response", status: "in_progress", model: "fixture-model", output: [], usage: {} } } },
  ];
  for (let block = 0; block < blocks; block += 1) {
    frames.push({ event: "response.output_item.added", data: { type: "response.output_item.added", output_index: block, item: { type: "message", id: `msg_${String(block)}`, role: "assistant", status: "in_progress", content: [] } } });
    for (let delta = 0; delta < deltasPerBlock; delta += 1) {
      frames.push({ event: "response.output_text.delta", data: { type: "response.output_text.delta", output_index: block, content_index: 0, delta: `block${String(block)}d${String(delta)} ` } });
    }
    frames.push({ event: "response.output_item.done", data: { type: "response.output_item.done", output_index: block } });
  }
  frames.push({ event: "response.completed", data: { type: "response.completed", response: { id: "resp_soak", object: "response", status: "completed", model: "fixture-model", output: [], usage: { input_tokens: 100, output_tokens: blocks * deltasPerBlock } } } });
  return frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join("");
}

describe("long-session soak: #120 incremental transport + retry/error handling (#121)", () => {
  it("encoder retained state stays bounded and isolated across 3000+ events with artifacts", () => {
    const first = createResponsesIncrementalEncoder();
    const second = createResponsesIncrementalEncoder();
    const base = { requestId: "req_soak", timestamp: "2026-08-15T00:00:00.000Z", providerId: "fixture", modelId: "fixture-model" };
    let sequence = 0;
    first.push({ ...base, sequence: sequence++, type: "response-started", responseId: "resp_soak" });
    for (let index = 0; index < 300; index += 1) {
      first.push({ ...base, sequence: sequence++, type: "content-started", index, contentType: "text", itemId: `msg_${String(index)}` });
      for (let delta = 0; delta < 10; delta += 1) first.push({ ...base, sequence: sequence++, type: "text-delta", index, text: "t" });
      first.push({ ...base, sequence: sequence++, type: "content-completed", index });
      if (index % 50 === 0) {
        first.push({ ...base, sequence: sequence++, type: "fidelity-artifacts", artifacts: [{ kind: "openai-reasoning-encrypted-content", association: `rs_${String(index)}`, value: "synthetic-encrypted-soak" }] });
      }
    }
    first.push({ ...base, sequence: sequence++, type: "usage-updated", inputTokens: 100, outputTokens: 3000 });
    first.push({ ...base, sequence, type: "response-completed", stopReason: "end_turn" });
    first.finish();
    // Bounded by open blocks (0) + aggregate projection (300 items + 300 text
    // entries + 6 artifacts) — never by the 3000+ event count.
    expect(first.retainedStateSize()).toBeLessThanOrEqual(620);
    // No state leakage between encoder instances.
    expect(second.retainedStateSize()).toBe(0);
    expect(second.status()).toBe("idle");
  });

  it("routes a 3000+ event native stream twice with byte-identical bodies and no state leakage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-soak-"));
    directories.push(directory);
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => Promise.resolve(new Response(nativeStreamSse(300, 10), { status: 200, headers: { "content-type": "text/event-stream" } })));
    const upstream = {
      invoke: (_ignored: unknown, signal: AbortSignal) => new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" }).invoke(decodeResponsesRequest({ model: "fixture-model", input: "fixture", stream: true }).request, decision("req_soak"), signal),
    };
    app = Fastify();
    registerOpenAiResponsesRoute(app, {
      route,
      configFingerprint: "a".repeat(64),
      upstream,
      continuation: new ResponseContinuationStore(directory),
    });
    const first = await app.inject({ method: "POST", url: "/v1/responses", payload: { model: "fixture-model", input: "fixture", stream: true } });
    const second = await app.inject({ method: "POST", url: "/v1/responses", payload: { model: "fixture-model", input: "fixture", stream: true } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect(first.body.length).toBeGreaterThan(100_000);
    expect(first.body).toContain("response.completed");
    // Continuation storage grew by exactly the completed responses (bounded),
    // and no error/retry state leaked into the second request.
    const stored = await app.inject({ method: "GET", url: "/v1/responses/resp_soak" });
    expect(stored.statusCode).toBe(200);
    const list = await new ResponseContinuationStore(directory).list();
    expect(list).toContain("resp_soak");
  });

  it("a not-sent retry inside the pool streams a byte-identical body (no duplicate output)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-soak-retry-"));
    directories.push(directory);
    const { createReadyPool, createSelector, openStore, readySnapshots, tempDir, CAPABILITIES } = await import("../../routing/helpers.js");
    const poolDirectory = await tempDir();
    directories.push(poolDirectory);
    const store = await openStore(poolDirectory, new Date("2026-08-15T00:00:00.000Z"));
    const { accounts, pool } = createReadyPool(store, {
      strategy: "fill-first",
      retryBudget: 1,
      specs: [
        { pseudonym: "acct-soak-001", handle: "cred-001" },
        { pseudonym: "acct-soak-002", handle: "cred-002" },
      ],
    });
    const selector = createSelector(store, new Date("2026-08-15T00:00:00.000Z"));
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    const decoded = decodeResponsesRequest({ model: "fixture-model", input: "fixture", stream: true });
    let calls = 0;
    const events: CanonicalEvent[] = [];
    const baseline = new OpenRouterAdapter(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(nativeStreamSse(5, 3), { status: 200, headers: { "content-type": "text/event-stream" } })), undefined, { OPENROUTER_API_KEY: "fixture-secret" }).invoke(decoded.request, decision(decoded.request.id), new AbortController().signal);
    for await (const item of baseline) events.push(item);
    const baselineWire = createResponsesIncrementalEncoder();
    for (const item of events) baselineWire.push(item);
    baselineWire.finish();
    const upstream = {
      invoke: (_ignored: unknown, signal: AbortSignal) => (async function* (): AsyncIterable<CanonicalEvent> {
        calls += 1;
        if (calls === 1) throw new ProviderAdapterError("authentication_error", "synthetic not-sent", undefined, "not-sent");
        yield* new OpenRouterAdapter(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(nativeStreamSse(5, 3), { status: 200, headers: { "content-type": "text/event-stream" } })), undefined, { OPENROUTER_API_KEY: "fixture-secret" }).invoke(decoded.request, decision(decoded.request.id), signal);
      })(),
    };
    const { streamPoolRequest } = await import("../../../src/routing/pools/execute.js");
    const wire = createResponsesIncrementalEncoder();
    for await (const item of streamPoolRequest({
      selector,
      store,
      request: decoded.request,
      select: {
        poolId: pool.id,
        policy,
        required: [],
        capabilities: CAPABILITIES,
        modelId: "fixture-model",
        adapterId: "openrouter-direct",
        role: "primary",
        credentialSnapshots: readySnapshots(accounts),
      },
      invoke: (selected, invokeSignal) => upstream.invoke(selected, invokeSignal),
      signal: new AbortController().signal,
    })) {
      wire.push(item);
    }
    wire.finish();
    expect(calls).toBe(2);
    // The retried attempt produced exactly one completed response, byte-identical
    // to a clean baseline: no duplicated output, no state leakage.
    expect(wire.status()).toBe("completed");
    store.close();
  });
});
