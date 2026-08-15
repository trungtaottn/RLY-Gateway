import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { decodeAnthropicRequest } from "../../src/protocols/anthropic/decoder.js";
import { aggregateAnthropicEvents, encodeAnthropicSse } from "../../src/protocols/anthropic/encoder.js";
import { FakeCanonicalUpstream } from "../../src/protocols/anthropic/fake-upstream.js";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/decoder.js";
import { ResponseContinuationStore } from "../../src/protocols/openai-responses/continuation.js";
import { OpenRouterAdapter } from "../../src/providers/direct/openrouter-adapter.js";
import { decideRoute, type RouteRecord } from "../../src/core/router.js";
import { artifactValue, describeFidelity } from "../../src/core/fidelity.js";
import type { CanonicalEvent } from "../../src/core/canonical-event.js";

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

const capabilities = { streaming: true, tools: true, parallelTools: false, images: true, reasoning: true, redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate" as const };
const baseRoute: RouteRecord = { role: "primary", providerId: "openrouter", modelId: "fixture-model", adapterId: "openrouter-direct", credentialRef: { kind: "env", name: "OPENROUTER_API_KEY" }, capabilities };

function fixture(name: string): Promise<{ request: Record<string, unknown> }> {
  return readFile(join(process.cwd(), "tests/fixtures/protocol", name), "utf8").then((raw) => JSON.parse(raw) as { request: Record<string, unknown> });
}

describe("Anthropic thinking signature fidelity (#119)", () => {
  it("preserves a thinking signature into the fidelity envelope with provenance", async () => {
    const { request } = await fixture("anthropic-thinking-signature.json");
    const decoded = decodeAnthropicRequest(request, { "anthropic-version": "2023-06-01" });
    const envelope = decoded.request.fidelity;
    expect(envelope).toBeDefined();
    expect(envelope?.sourceProtocol).toBe("anthropic-messages");
    expect(envelope?.protocolRevision).toBe("2023-06-01");
    expect(envelope?.required).toContain("anthropic-thinking-signature");
    const artifact = envelope?.artifacts.find((item) => item.kind === "anthropic-thinking-signature");
    expect(artifact).toEqual({ kind: "anthropic-thinking-signature", association: "1:0", value: "synthetic-thinking-signature-value" });
    const signatureNote = envelope?.notes.find((note) => note.field.endsWith("thinking.signature"));
    expect(signatureNote?.disposition).toBe("preserved-native");
    expect(envelope?.notes.some((note) => note.disposition === "translated")).toBe(true);
    // Semantic projection keeps the reasoning text; signature stays opaque.
    expect(decoded.request.input.some((item) => item.type === "reasoning")).toBe(true);
    expect(decoded.required).toContain("reasoning");
  });

  it("does not create a fidelity envelope when no signature or unknown fields exist", () => {
    const decoded = decodeAnthropicRequest({ model: "fixture-model", max_tokens: 1, messages: [{ role: "user", content: "fixture" }] });
    expect(decoded.request.fidelity).toBeUndefined();
  });

  it("emits signature_delta in valid order and attaches the signature on aggregate", () => {
    const request = decodeAnthropicRequest({ model: "fixture-model", max_tokens: 1, messages: [{ role: "user", content: "fixture" }] }).request;
    const base = { requestId: request.id, timestamp: "2026-08-13T00:00:00.000Z", providerId: "fake", modelId: "fixture-model" };
    const events: CanonicalEvent[] = [
      { ...base, sequence: 0, type: "response-started", responseId: "msg_fixture" },
      { ...base, sequence: 1, type: "content-started", index: 0, contentType: "reasoning" },
      { ...base, sequence: 2, type: "reasoning-delta", index: 0, text: "thinking text" },
      { ...base, sequence: 3, type: "signature-delta", index: 0, signature: "synthetic-signature" },
      { ...base, sequence: 4, type: "content-completed", index: 0 },
      { ...base, sequence: 5, type: "response-completed", stopReason: "end_turn" },
    ];
    const sse = encodeAnthropicSse(events);
    const thinkingDelta = sse.indexOf('"type":"thinking_delta"');
    const signatureDelta = sse.indexOf('"type":"signature_delta"');
    const blockStop = sse.indexOf('"type":"content_block_stop"');
    expect(thinkingDelta).toBeGreaterThan(-1);
    expect(signatureDelta).toBeGreaterThan(thinkingDelta);
    expect(blockStop).toBeGreaterThan(signatureDelta);
    expect(sse).toContain('"signature":"synthetic-signature"');
    expect(aggregateAnthropicEvents(events)).toMatchObject({
      content: [{ type: "thinking", thinking: "thinking text", signature: "synthetic-signature" }],
    });
  });

  it("emits signature_delta SSE bytes matching the deterministic golden fixture", async () => {
    const raw = await readFile(join(process.cwd(), "tests/fixtures/protocol/anthropic-signature-delta-sse.json"), "utf8");
    const golden = (JSON.parse(raw) as { sse: string }).sse;
    const request = decodeAnthropicRequest({ model: "fixture-model", max_tokens: 1, messages: [{ role: "user", content: "fixture" }] }).request;
    const base = { requestId: request.id, timestamp: "2026-08-13T00:00:00.000Z", providerId: "fake", modelId: "fixture-model" };
    const events: CanonicalEvent[] = [
      { ...base, sequence: 0, type: "response-started", responseId: "msg_fixture" },
      { ...base, sequence: 1, type: "content-started", index: 0, contentType: "reasoning" },
      { ...base, sequence: 2, type: "reasoning-delta", index: 0, text: "thinking text" },
      { ...base, sequence: 3, type: "signature-delta", index: 0, signature: "synthetic-signature" },
      { ...base, sequence: 4, type: "content-completed", index: 0 },
      { ...base, sequence: 5, type: "response-completed", stopReason: "end_turn" },
    ];
    expect(encodeAnthropicSse(events)).toBe(golden);
  });

  it("fails closed when a signature delta targets a non-thinking block", () => {
    const request = decodeAnthropicRequest({ model: "fixture-model", max_tokens: 1, messages: [{ role: "user", content: "fixture" }] }).request;
    const base = { requestId: request.id, timestamp: "2026-08-13T00:00:00.000Z", providerId: "fake", modelId: "fixture-model" };
    const events: CanonicalEvent[] = [
      { ...base, sequence: 0, type: "response-started", responseId: "msg_fixture" },
      { ...base, sequence: 1, type: "content-started", index: 0, contentType: "text" },
      { ...base, sequence: 2, type: "signature-delta", index: 0, signature: "synthetic-signature" },
    ];
    expect(() => encodeAnthropicSse(events)).toThrow(/non-thinking block/);
  });

  it("fails closed when a signature delta arrives before its content block", () => {
    const request = decodeAnthropicRequest({ model: "fixture-model", max_tokens: 1, messages: [{ role: "user", content: "fixture" }] }).request;
    const base = { requestId: request.id, timestamp: "2026-08-13T00:00:00.000Z", providerId: "fake", modelId: "fixture-model" };
    const events: CanonicalEvent[] = [
      { ...base, sequence: 0, type: "response-started", responseId: "msg_fixture" },
      { ...base, sequence: 1, type: "signature-delta", index: 0, signature: "synthetic-signature" },
    ];
    expect(() => encodeAnthropicSse(events)).toThrow(/Signature delta before content start/);
  });

  it("records unknown additive fields as intentionally ignored (Anthropic)", async () => {
    const { request } = await fixture("anthropic-unknown-additive.json");
    const decoded = decodeAnthropicRequest(request, { "anthropic-version": "2023-06-01" });
    const envelope = decoded.request.fidelity;
    expect(envelope).toBeDefined();
    const ignoredNote = envelope?.notes.find((note) => note.field === "foo_additive_field");
    expect(ignoredNote?.disposition).toBe("ignored");
    expect(envelope?.notes.some((note) => note.disposition === "preserved-native")).toBe(false);
    expect(envelope?.required).toEqual([]);
    expect(decoded.ignoredAdditiveFields).toContain("foo_additive_field");
  });

  it("fails closed on a cross-protocol path that cannot represent a required thinking signature", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    const { request } = await fixture("anthropic-thinking-signature.json");
    const decoded = decodeAnthropicRequest(request, { "anthropic-version": "2023-06-01" });
    const decision = decideRoute({ requestId: decoded.request.id, route: baseRoute, required: decoded.required, configFingerprint: "a".repeat(64) });
    await expect(async () => {
      for await (const _ of adapter.invoke(decoded.request, decision, new AbortController().signal)) { void _; }
    }).rejects.toMatchObject({ code: "unsupported-fidelity" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("OpenAI Responses reasoning fidelity (#119)", () => {
  it("preserves reasoning item identity and encrypted content into the fidelity envelope", async () => {
    const { request } = await fixture("openai-reasoning-encrypted.json");
    const decoded = decodeResponsesRequest(request, { "openai-version": "2026-01-01" });
    const reasoning = decoded.request.messages.find((message) => message.role === "assistant")?.content.find((item) => item.type === "reasoning");
    expect(reasoning).toMatchObject({ type: "reasoning", id: "rs_fixture", text: "redacted fixture summary" });
    const envelope = decoded.request.fidelity;
    expect(envelope).toBeDefined();
    expect(envelope?.required).toContain("openai-reasoning-encrypted-content");
    const artifact = envelope?.artifacts.find((item) => item.kind === "openai-reasoning-encrypted-content");
    expect(artifact).toEqual({ kind: "openai-reasoning-encrypted-content", association: "rs_fixture", value: "synthetic-encrypted-content-value" });
    expect(envelope?.notes.some((note) => note.disposition === "preserved-native")).toBe(true);
    expect(envelope?.notes.some((note) => note.disposition === "translated")).toBe(true);
  });

  it("round-trips identity and encrypted content through continuation storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-fidelity-"));
    try {
      const store = new ResponseContinuationStore(directory);
      const decoded = decodeResponsesRequest({
        model: "fixture-model",
        input: [{ type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "redacted fixture summary" }], encrypted_content: "synthetic-encrypted-content-value" }],
      });
      const events = await collect(new FakeCanonicalUpstream().invoke(decoded.request, new AbortController().signal));
      const remembered = await store.remember(decoded.request, events);
      expect(remembered).toBeDefined();
      if (!remembered) throw new Error("expected stored response");
      const obj = store.toResponsesObject(remembered);
      const reasoningItem = (obj.output as readonly { type?: string }[]).find((item) => item.type === "reasoning");
      expect(reasoningItem).toMatchObject({ id: "rs_fixture", encrypted_content: "synthetic-encrypted-content-value" });
      // The stored record keeps the artifact association, not just the summary text.
      const stored = await store.get(remembered.id);
      expect(artifactValue(stored?.fidelity, "openai-reasoning-encrypted-content", "rs_fixture")).toBe("synthetic-encrypted-content-value");
      // A subsequent turn carries the artifact forward into the continued request.
      const next = decodeResponsesRequest({ model: "fixture-model", previous_response_id: remembered.id, input: "next turn" }).request;
      const continued = await store.apply(next);
      expect(artifactValue(continued.fidelity, "openai-reasoning-encrypted-content", "rs_fixture")).toBe("synthetic-encrypted-content-value");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on a cross-protocol path that cannot represent required encrypted content", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = new OpenRouterAdapter(fetch, undefined, { OPENROUTER_API_KEY: "fixture-secret" });
    const decoded = decodeResponsesRequest({
      model: "fixture-model",
      input: [{ type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "redacted fixture summary" }], encrypted_content: "synthetic-encrypted-content-value" }],
    });
    const decision = decideRoute({ requestId: decoded.request.id, route: baseRoute, required: [], configFingerprint: "a".repeat(64) });
    await expect(async () => {
      for await (const _ of adapter.invoke(decoded.request, decision, new AbortController().signal)) { void _; }
    }).rejects.toMatchObject({ code: "unsupported-fidelity" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fabricate encrypted content for reasoning without it", () => {
    const decoded = decodeResponsesRequest({ model: "fixture-model", input: [{ type: "reasoning", summary: [{ type: "summary_text", text: "summary only" }] }] });
    expect(decoded.request.fidelity).toBeUndefined();
    const reasoning = decoded.request.messages[0]?.content[0];
    expect(reasoning).toMatchObject({ type: "reasoning", text: "summary only" });
    expect(reasoning).not.toHaveProperty("encrypted_content");
  });

  it("records unknown additive fields as intentionally ignored (Responses)", async () => {
    const { request } = await fixture("openai-unknown-additive.json");
    const decoded = decodeResponsesRequest(request, { "openai-version": "2026-01-01" });
    const envelope = decoded.request.fidelity;
    expect(envelope).toBeDefined();
    const ignoredNote = envelope?.notes.find((note) => note.field === "custom_additive_field");
    expect(ignoredNote?.disposition).toBe("ignored");
    expect(envelope?.required).toEqual([]);
    expect(decoded.ignoredAdditiveFields).toContain("custom_additive_field");
  });

  it("keeps opaque artifact association on the correct reasoning item across tool-interleaved multi-turn continuation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-fidelity-"));
    try {
      const store = new ResponseContinuationStore(directory);
      // Turn 1: reasoning (rs_turn1 + opaque encrypted content) interleaved with a tool call/result.
      const turn1 = decodeResponsesRequest({
        model: "fixture-model",
        input: [
          { type: "reasoning", id: "rs_turn1", summary: [{ type: "summary_text", text: "redacted fixture summary turn 1" }], encrypted_content: "synthetic-encrypted-content-turn1" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "redacted fixture tool ask turn 1" }] },
          { type: "function_call", call_id: "call_fixture_1", name: "fixture_tool", arguments: "{\"unit\":\"fixture-turn-1\"}" },
          { type: "function_call_output", call_id: "call_fixture_1", output: "redacted fixture result turn 1" },
        ],
      });
      const events1 = await collect(new FakeCanonicalUpstream().invoke(turn1.request, new AbortController().signal));
      const stored1 = await store.remember(turn1.request, events1);
      expect(stored1).toBeDefined();
      if (!stored1) throw new Error("expected stored response");
      expect(artifactValue(stored1.fidelity, "openai-reasoning-encrypted-content", "rs_turn1")).toBe("synthetic-encrypted-content-turn1");

      // Turn 2 (fixture): reasoning rs_turn2 + text + tool call/result, continued by response id.
      const { request } = await fixture("openai-reasoning-tool-interleave.json");
      const turn2 = decodeResponsesRequest(request, { "openai-version": "2026-01-01" });
      const continued = await store.apply({ ...turn2.request, continuation: { previousResponseId: stored1.id } });
      // Both opaque artifacts ride the merged envelope into the next turn, each at its own association.
      expect(artifactValue(continued.fidelity, "openai-reasoning-encrypted-content", "rs_turn1")).toBe("synthetic-encrypted-content-turn1");
      expect(artifactValue(continued.fidelity, "openai-reasoning-encrypted-content", "rs_turn2")).toBe("synthetic-encrypted-content-turn2");
      // The continued request never reconstructs opaque content from summary text.
      expect(JSON.stringify(continued.messages)).not.toContain("synthetic-encrypted-content-turn2");

      const events2 = await collect(new FakeCanonicalUpstream().invoke(continued, new AbortController().signal));
      const stored2 = await store.remember(continued, events2);
      expect(stored2).toBeDefined();
      if (!stored2) throw new Error("expected stored response");
      const obj = store.toResponsesObject(stored2);
      const reasoningItems = (obj.output as readonly { type?: string; id?: string; encrypted_content?: string }[]).filter((item) => item.type === "reasoning");
      expect(reasoningItems.find((item) => item.id === "rs_turn1")?.encrypted_content).toBe("synthetic-encrypted-content-turn1");
      expect(reasoningItems.find((item) => item.id === "rs_turn2")?.encrypted_content).toBe("synthetic-encrypted-content-turn2");
      // Tool items stay attached to their own call ids in the aggregated object.
      const calls = (obj.output as readonly { type?: string; call_id?: string }[]).filter((item) => item.type === "function_call");
      expect(calls.map((item) => item.call_id)).toEqual(["call_fixture_1", "call_fixture_2"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("fidelity diagnostics privacy (#119)", () => {
  it("describes fidelity with provenance metadata only, never artifact values", () => {
    const decoded = decodeResponsesRequest({
      model: "fixture-model",
      input: [{ type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "redacted fixture summary" }], encrypted_content: "synthetic-encrypted-content-value" }],
    });
    const envelope = decoded.request.fidelity;
    expect(envelope).toBeDefined();
    if (!envelope) throw new Error("expected envelope");
    const summary = describeFidelity(envelope);
    expect(summary.artifactKinds).toContain("openai-reasoning-encrypted-content");
    expect(JSON.stringify(summary)).not.toContain("synthetic-encrypted-content-value");
    expect(JSON.stringify(summary)).not.toContain("rs_fixture");
  });
});
