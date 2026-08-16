import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "../../src/core/canonical-event.js";
import { createAnthropicIncrementalEncoder, encodeAnthropicEvents, encodeAnthropicSse, type AnthropicWireEvent } from "../../src/protocols/anthropic/encoder.js";
import { createResponsesIncrementalEncoder, encodeResponsesEvents, encodeResponsesSse, type ResponsesWireEvent } from "../../src/protocols/openai-responses/encoder.js";

const base = { requestId: "req_fixture", timestamp: "2026-08-15T00:00:00.000Z", providerId: "fake", modelId: "fixture-model" };

function events(types: Array<[number, CanonicalEvent["type"], object]>): CanonicalEvent[] {
  return types.map(([sequence, type, data]) => ({ ...base, sequence, type, ...data }) as CanonicalEvent);
}

/** text: start → N text deltas → stop → usage → completed. */
function textStream(deltas: number): CanonicalEvent[] {
  const items: Array<[number, CanonicalEvent["type"], object]> = [
    [0, "response-started", { responseId: "msg_fixture" }],
    [1, "content-started", { index: 0, contentType: "text" }],
  ];
  let sequence = 2;
  for (let i = 0; i < deltas; i += 1) items.push([sequence++, "text-delta", { index: 0, text: `t${i}` }]);
  items.push([sequence++, "content-completed", { index: 0 }]);
  items.push([sequence++, "usage-updated", { inputTokens: 10, outputTokens: deltas }]);
  items.push([sequence++, "response-completed", { stopReason: "end_turn" }]);
  return events(items);
}

/** tool: start → argument deltas (valid concatenated JSON) → stop → usage → completed. */
function toolStream(deltas: number): CanonicalEvent[] {
  const items: Array<[number, CanonicalEvent["type"], object]> = [
    [0, "response-started", { responseId: "msg_fixture" }],
    [1, "content-started", { index: 0, contentType: "tool-call", toolCallId: "tool_fixture", toolName: "fixture_tool" }],
  ];
  let sequence = 2;
  // Concatenation stays valid JSON: `{"k0":0,"k1":1,...}`.
  for (let i = 0; i < deltas; i += 1) {
    items.push([sequence++, "tool-arguments-delta", { index: 0, toolCallId: "tool_fixture", partialJson: `${i === 0 ? "{" : ","}"k${i}":${i}` }]);
  }
  items.push([sequence++, "tool-arguments-delta", { index: 0, toolCallId: "tool_fixture", partialJson: "}" }]);
  items.push([sequence++, "content-completed", { index: 0 }]);
  items.push([sequence++, "usage-updated", { inputTokens: 5, outputTokens: 8 }]);
  items.push([sequence++, "response-completed", { stopReason: "tool_use" }]);
  return events(items);
}

/** reasoning + signature + text, then a tool block interleaved (#119 fidelity shape). */
function reasoningToolInterleave(): CanonicalEvent[] {
  return events([
    [0, "response-started", { responseId: "msg_fixture" }],
    [1, "content-started", { index: 0, contentType: "reasoning" }],
    [2, "reasoning-delta", { index: 0, text: "thinking one" }],
    [3, "signature-delta", { index: 0, signature: "synthetic-signature-value" }],
    [4, "content-completed", { index: 0 }],
    [5, "content-started", { index: 1, contentType: "text" }],
    [6, "text-delta", { index: 1, text: "plan" }],
    [7, "content-completed", { index: 1 }],
    [8, "content-started", { index: 2, contentType: "tool-call", toolCallId: "tool_interleave", toolName: "interleave_tool" }],
    [9, "tool-arguments-delta", { index: 2, toolCallId: "tool_interleave", partialJson: "{\"unit\":\"fixture\"}" }],
    [10, "content-completed", { index: 2 }],
    [11, "usage-updated", { inputTokens: 22, outputTokens: 44 }],
    [12, "response-completed", { stopReason: "tool_use" }],
  ]);
}

function redactedReasoning(): CanonicalEvent[] {
  return events([
    [0, "response-started", { responseId: "msg_fixture" }],
    [1, "content-started", { index: 0, contentType: "redacted-reasoning" }],
    [2, "content-completed", { index: 0 }],
    [3, "response-completed", { stopReason: "end_turn" }],
  ]);
}

function incrementalSse<Wire>(eventsList: readonly CanonicalEvent[], encoder: { push(event: CanonicalEvent): readonly Wire[] }, frame: (wire: Wire) => string): string {
  let output = "";
  for (const item of eventsList) for (const wire of encoder.push(item)) output += frame(wire);
  return output;
}

const anthropicFrame = (wire: AnthropicWireEvent): string => `event: ${wire.event}\ndata: ${JSON.stringify(wire.data)}\n\n`;
const responsesFrame = (wire: ResponsesWireEvent): string => `event: ${wire.event}\ndata: ${JSON.stringify(wire.data)}\n\n`;

describe("incremental encoders stay wire-equivalent to batch encoders (#120)", () => {
  it.each([
    ["anthropic-text", textStream(40), true],
    ["anthropic-tool", toolStream(30), true],
    ["anthropic-reasoning-tool-interleave", reasoningToolInterleave(), true],
    ["anthropic-redacted-reasoning", redactedReasoning(), true],
  ])("Anthropic %s", (_name, stream, _) => {
    const incremental = incrementalSse(stream, createAnthropicIncrementalEncoder(), anthropicFrame);
    // Byte-identical to the current re-encode-then-slice output on the same
    // canonical stream.
    expect(incremental).toBe(encodeAnthropicSse(stream));
  });

  it.each([
    ["responses-text", textStream(40), true],
    ["responses-tool", toolStream(30), true],
    ["responses-reasoning-tool-interleave", reasoningToolInterleave(), true],
    ["responses-redacted-reasoning", redactedReasoning(), true],
  ])("Responses %s", (_name, stream, _) => {
    const incremental = incrementalSse(stream, createResponsesIncrementalEncoder(), responsesFrame);
    expect(incremental).toBe(encodeResponsesSse(stream));
  });

  it("emits the #119 signature_delta ordering byte-for-byte via the incremental path", () => {
    const stream = reasoningToolInterleave();
    const incremental = incrementalSse(stream, createAnthropicIncrementalEncoder(), anthropicFrame);
    const thinkingDelta = incremental.indexOf('"type":"thinking_delta"');
    const signatureDelta = incremental.indexOf('"type":"signature_delta"');
    const blockStop = incremental.indexOf('"type":"content_block_stop"');
    expect(signatureDelta).toBeGreaterThan(thinkingDelta);
    expect(blockStop).toBeGreaterThan(signatureDelta);
  });

  it("reports the same total frame count when each event is pushed exactly once", () => {
    const stream = reasoningToolInterleave();
    const batch = encodeAnthropicEvents(stream);
    const encoder = createAnthropicIncrementalEncoder();
    const frames = stream.flatMap((event) => encoder.push(event));
    expect(frames).toHaveLength(batch.length);
  });
});

describe("incremental encoders are linear with bounded protocol state (#120)", () => {
  it("Anthropic retains only open-block state, never the event history", () => {
    for (const deltas of [1, 10, 1_000]) {
      const stream = textStream(deltas);
      const encoder = createAnthropicIncrementalEncoder();
      for (const item of stream) void encoder.push(item);
      // One open text block at its peak; constant regardless of event count.
      const peak = (() => {
        const probe = createAnthropicIncrementalEncoder();
        let max = 0;
        for (const item of textStream(deltas)) { probe.push(item); max = Math.max(max, probe.retainedStateSize()); }
        return max;
      })();
      expect(peak).toBe(1);
      // Retained state is bounded by open blocks, never by N deltas.
      expect(encoder.retainedStateSize()).toBe(0);
    }
  });

  it("Responses retains only the aggregate projection, bounded by output not event count", () => {
    const deltas = 1_000;
    const stream = textStream(deltas);
    const encoder = createResponsesIncrementalEncoder();
    for (const item of stream) void encoder.push(item);
    // One output item + one text accumulator + closed open set: ~2 entries,
    // independent of the 1000 delta events.
    expect(encoder.retainedStateSize()).toBeLessThanOrEqual(3);
    expect(encoder.retainedStateSize()).toBeGreaterThan(0);
  });

  it("finish() fails closed on a stream that ends with open content, like the batch encoder", () => {
    const malformed = events([
      [0, "response-started", { responseId: "msg_fixture" }],
      [1, "content-started", { index: 0, contentType: "text" }],
      [2, "text-delta", { index: 0, text: "never closed" }],
    ]);
    const batch = () => encodeAnthropicEvents(malformed, true);
    const incremental = createAnthropicIncrementalEncoder();
    for (const item of malformed) void incremental.push(item);
    expect(batch).toThrow(/open content/);
    expect(() => incremental.finish()).toThrow(/open content/);
    const responsesBatch = () => encodeResponsesEvents(malformed, true);
    const responsesIncremental = createResponsesIncrementalEncoder();
    for (const item of malformed) void responsesIncremental.push(item);
    expect(responsesBatch).toThrow(/open content/);
    expect(() => responsesIncremental.finish()).toThrow(/open content/);
  });

  it("exposes continuation-ready aggregate state for a completed Responses stream", () => {
    const stream = reasoningToolInterleave();
    const encoder = createResponsesIncrementalEncoder();
    for (const item of stream) void encoder.push(item);
    encoder.finish();
    expect(encoder.status()).toBe("completed");
    const aggregated = encoder.aggregate();
    expect(aggregated.id).toBe("msg_fixture");
    expect(aggregated.model).toBe("fixture-model");
    const types = (aggregated.output as readonly { type?: string }[]).map((item) => item.type);
    expect(types).toEqual(["reasoning", "message", "function_call"]);
    // The aggregate carries reasoning + tool state for continuation storage.
    const reasoning = (aggregated.output as readonly { type?: string; summary?: unknown }[]).find((item) => item.type === "reasoning");
    expect(reasoning?.summary).toEqual([{ type: "summary_text", text: "thinking one" }]);
    const tool = (aggregated.output as readonly { type?: string; arguments?: string }[]).find((item) => item.type === "function_call");
    expect(tool?.arguments).toBe('{"unit":"fixture"}');
  });
});
