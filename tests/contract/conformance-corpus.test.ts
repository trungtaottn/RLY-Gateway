import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CanonicalEvent } from "../../src/core/canonical-event.js";
import { decideRoute, type RouteRecord } from "../../src/core/router.js";
import { decodeAnthropicRequest } from "../../src/protocols/anthropic/decoder.js";
import { encodeAnthropicEvents } from "../../src/protocols/anthropic/encoder.js";
import { FakeCanonicalUpstream } from "../../src/protocols/anthropic/fake-upstream.js";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/decoder.js";
import { encodeResponsesEvents } from "../../src/protocols/openai-responses/encoder.js";
import { OpenRouterAdapter } from "../../src/providers/direct/openrouter-adapter.js";
import { parseProviderError } from "../../src/providers/provider-error.js";
import { ProviderAdapterError } from "../../src/providers/provider-adapter.js";
import type { ProviderErrorInfo } from "../../src/providers/provider-error.js";
import { emptyFidelityEnvelope, withArtifacts, type FidelityEnvelope } from "../../src/core/fidelity.js";

const capabilities = { streaming: true, tools: true, parallelTools: false, images: false, reasoning: true, redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate" as const };
const route: RouteRecord = { role: "primary", providerId: "openrouter", modelId: "fixture-model", adapterId: "openrouter-direct", credentialRef: { kind: "env", name: "OPENROUTER_API_KEY" }, capabilities };

const FIXTURES = "tests/fixtures/protocol";

async function readFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(`${FIXTURES}/${name}`, "utf8")) as T;
}

function framesOf(sse: string): Array<{ event: string; data: unknown }> {
  const frames: Array<{ event: string; data: unknown }> = [];
  for (const record of sse.split(/\r?\n\r?\n/).filter(Boolean)) {
    let event = "";
    const dataLines: string[] = [];
    for (const line of record.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    frames.push({ event, data: JSON.parse(dataLines.join("\n")) as unknown });
  }
  return frames;
}

function providerSse(frames: readonly { event: string; data: unknown }[]): string {
  return frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join("");
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

function decisionFor(requestId: string) {
  return decideRoute({ requestId, route, required: [], configFingerprint: "a".repeat(64) });
}

/** #121 Wave 1 conformance corpus: expected WIRE semantics per scenario. */
describe("Wave 1 conformance corpus (#121)", () => {
  it("native Responses stream: reasoning + text + tool interleave keeps item identity and artifacts on the wire", async () => {
    const fixture = await readFixture<{
      inboundFrames: Array<{ event: string; data: unknown }>;
      expectedCanonicalTypes: string[];
      expectedItemIds: string[];
      expectedClientFrames: Array<{ event: string; data: unknown }>;
    }>("responses-native-rail-stream.json");
    const decoded = decodeResponsesRequest({ model: "fixture-model", input: "fixture", stream: true, max_output_tokens: 256, reasoning: { effort: "medium" } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(providerSse(fixture.inboundFrames), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    const events = await collect(adapter.invoke(decoded.request, decisionFor(decoded.request.id), new AbortController().signal));
    expect(events.map((item) => item.type)).toEqual(fixture.expectedCanonicalTypes);
    const started = events.filter((item): item is Extract<CanonicalEvent, { type: "content-started" }> => item.type === "content-started");
    expect(started.map((item) => item.itemId)).toEqual(fixture.expectedItemIds);
    const artifacts = events.find((item): item is Extract<CanonicalEvent, { type: "fidelity-artifacts" }> => item.type === "fidelity-artifacts");
    expect(artifacts?.artifacts).toContainEqual({ kind: "openai-reasoning-encrypted-content", association: "rs_0", value: "synthetic-encrypted-native" });
    // WIRE semantics: the client-facing re-encode carries provider item ids,
    // ordering, and the opaque artifact — not just canonical equivalence.
    const clientFrames = encodeResponsesEvents(events).map((wire) => ({ event: wire.event, data: wire.data }));
    expect(clientFrames).toEqual(fixture.expectedClientFrames);
  });

  it("native Responses error: safe structured rate-limit metadata survives with retry-after and commitment", async () => {
    const fixture = await readFixture<{
      response: { status: number; headers: Record<string, string>; body: unknown };
      expectedCommitment: string;
    }>("responses-native-rail-error.json");
    const response = new Response(JSON.stringify(fixture.response.body), {
      status: fixture.response.status,
      headers: fixture.response.headers,
    });
    const info = await parseProviderError(response);
    expect(info.statusCode).toBe(429);
    expect(info.code).toBe("rate_limit_error");
    expect(info.type).toBe("rate_limit_error");
    expect(info.message).toBe("You are sending requests too quickly (synthetic).");
    expect(info.retryAfterSeconds).toBe(37);
    expect(info.rateLimit).toEqual({ limit: 1000, remaining: 0, resetSeconds: 37 });
    expect(info.param).toBeUndefined();
    // deterministic 4xx rejection is rotation-safe (not-sent commitment)
    const { commitmentForHttpFailure } = await import("../../src/providers/provider-error.js");
    expect(commitmentForHttpFailure(response)).toBe(fixture.expectedCommitment);
  });

  it("native Responses disconnect after acceptance: ambiguous failure defaults to no replay", async () => {
    const fixture = await readFixture<{ inboundFrames: Array<{ event: string; data: unknown }> }>("responses-native-rail-disconnect.json");
    const decoded = decodeResponsesRequest({ model: "fixture-model", input: "fixture", stream: true });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(providerSse(fixture.inboundFrames), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    const error = await collect(adapter.invoke(decoded.request, decisionFor(decoded.request.id), new AbortController().signal)).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect((error as ProviderAdapterError).commitment).toBe("provider-accepted");
  });

  it("native Responses continuation request: previous_response_id, encrypted content, include[], and item ordering on the outbound body", async () => {
    const fixture = await readFixture<{
      canonicalRequest: {
        messages: { role: string; content: unknown[] }[];
        tools: unknown[];
      };
      fidelityArtifacts: { kind: string; association: string; value: string }[];
      expectedOutboundBody: Record<string, unknown>;
    }>("responses-native-rail-request.json");
    let fidelity: FidelityEnvelope | undefined = emptyFidelityEnvelope("openai-responses");
    fidelity = withArtifacts(fidelity, fixture.fidelityArtifacts);
    const request = {
      id: "req_continuation",
      source: { protocol: "openai-responses" as const },
      requestedModel: "fixture-model",
      modelRole: "unknown" as const,
      system: [],
      input: [],
      messages: fixture.canonicalRequest.messages.map((message) => ({ role: message.role as "user" | "assistant", content: message.content as never[] })),
      tools: fixture.canonicalRequest.tools as never[],
      stream: false,
      inference: {},
      metadata: {},
      continuation: { previousResponseId: "resp_prev" },
      fidelity,
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "resp_x", object: "response", status: "completed", model: "fixture-model", output: [], usage: {} }), { status: 200 }));
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    for await (const _ of adapter.invoke(request as never, decisionFor(request.id), new AbortController().signal)) { void _; }
    const outbound = fetch.mock.calls[0]?.[1]?.body;
    expect(typeof outbound === "string" ? JSON.parse(outbound) as unknown : undefined).toEqual(fixture.expectedOutboundBody);
  });

  it("Anthropic supported translation path: text/tool/stop/reasoning wire semantics (non-streaming aggregate)", async () => {
    // Canonical → Anthropic wire is deterministic and already pinned; the
    // corpus records the STOP/error/cancellation wire semantics too.
    const decoded = decodeAnthropicRequest({ model: "fixture-model", max_tokens: 42, messages: [{ role: "user", content: "fixture" }], stream: true });
    const events = await collect(new FakeCanonicalUpstream("tool").invoke(decoded.request, new AbortController().signal));
    const frames = encodeAnthropicEvents(events);
    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_delta", "message_stop",
    ]);
    expect(frames.at(-2)).toMatchObject({ data: { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: {} } });
  });

  it("Anthropic supported translation path: failed event carries the safe provider message on the wire", async () => {
    const upstream = new FakeCanonicalUpstream("rate-limit");
    const decoded = decodeAnthropicRequest({ model: "fixture-model", max_tokens: 42, messages: [{ role: "user", content: "fixture" }], stream: true });
    const events = await collect(upstream.invoke(decoded.request, new AbortController().signal));
    const frames = encodeAnthropicEvents(events);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ event: "error", data: { type: "error", error: { type: "rate_limit_error", message: "synthetic upstream failure" } } });
  });
});
