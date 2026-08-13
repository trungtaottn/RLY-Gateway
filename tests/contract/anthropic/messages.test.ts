import { describe, expect, it } from "vitest";
import { decodeAnthropicRequest } from "../../../src/protocols/anthropic/decoder.js";
import { aggregateAnthropicEvents, encodeAnthropicSse } from "../../../src/protocols/anthropic/encoder.js";
import { FakeCanonicalUpstream } from "../../../src/protocols/anthropic/fake-upstream.js";
import type { CanonicalEvent } from "../../../src/core/canonical-event.js";
import { bindClientAbort } from "../../../src/routes/anthropic-messages-route.js";
import { EventEmitter } from "node:events";

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const item of items) result.push(item); return result; }

const body = { model: "fixture-model", max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text: "redacted fixture" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "fixture-data" } }] }], tools: [{ name: "fixture_tool", input_schema: { type: "object" } }], stream: true };

describe("Anthropic Messages protocol", () => {
  it("loss-aware decodes tagged content and declares requirements", () => {
    const decoded = decodeAnthropicRequest(body, { "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" });
    expect(decoded.request.source).toEqual({ protocol: "anthropic-messages", protocolVersion: "2023-06-01" });
    expect(decoded.request.input.map((item) => item.type)).toEqual(["text", "image"]);
    expect(decoded.required).toEqual(["streaming", "tools", "images"]);
  });

  it("preserves role, tool-result content, cache placement and thinking preflight", () => {
    const decoded = decodeAnthropicRequest({ model: "fixture-model", max_tokens: 10, thinking: { type: "enabled" }, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "tool_fixture", name: "fixture_tool", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_fixture", content: [{ type: "text", text: "fixture result", cache_control: { type: "ephemeral" } }] }] }] });
    expect(decoded.request.messages.map((message) => message.role)).toEqual(["assistant", "user"]);
    expect(decoded.request.messages[1]?.content[0]).toMatchObject({ type: "tool-result", content: [{ type: "text", text: "fixture result" }] });
    expect(decoded.request.metadata.cacheControl).toEqual([{ scope: "message", index: 1 }]);
    expect(decoded.required).toContain("reasoning");
  });

  it("golden-streams exact framing, event ordering, tool argument deltas and usage", async () => {
    const decoded = decodeAnthropicRequest({ ...body, messages: [{ role: "user", content: "fixture" }], stream: true });
    const events = await collect(new FakeCanonicalUpstream("tool").invoke(decoded.request, new AbortController().signal));
    expect(encodeAnthropicSse(events)).toBe([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fake","type":"message","role":"assistant","content":[],"model":"fixture-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"fixture-tool","name":"fixture_tool","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"unit\\":\\"fixture\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"input_tokens":12,"output_tokens":4}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join(""));
  });

  it("aggregates non-streaming events without changing text semantics", async () => {
    const decoded = decodeAnthropicRequest({ ...body, messages: [{ role: "user", content: "fixture" }], stream: false });
    const events = await collect(new FakeCanonicalUpstream().invoke(decoded.request, new AbortController().signal));
    expect(aggregateAnthropicEvents(events)).toMatchObject({ id: "msg_fake", content: [{ type: "text", text: "synthetic response" }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 4 } });
  });

  it("rejects invalid non-stream provenance and encodes redacted thinking", () => {
    const request = decodeAnthropicRequest({ model: "fixture-model", max_tokens: 1, messages: [{ role: "user", content: "fixture" }] }).request;
    const base = { requestId: request.id, timestamp: "2026-08-13T00:00:00.000Z", providerId: "fake", modelId: "fixture-model" };
    const events: CanonicalEvent[] = [{ ...base, sequence: 0, type: "response-started", responseId: "msg_fixture" }, { ...base, sequence: 1, type: "content-started", index: 0, contentType: "redacted-reasoning" }, { ...base, sequence: 2, type: "content-completed", index: 0 }, { ...base, sequence: 3, type: "response-completed", stopReason: "end_turn" }];
    expect(encodeAnthropicSse(events)).toContain('"type":"redacted_thinking"');
    expect(() => aggregateAnthropicEvents([{ ...base, requestId: "other", sequence: 0, type: "response-started", responseId: "msg_fixture" }, ...events.slice(1)])).toThrow("mixed provenance");
  });
});

describe("client disconnect cancellation", () => {
  it("aborts outbound work on response-side close and removes listeners", () => {
    const request = new EventEmitter();
    const response = new EventEmitter();
    const controller = new AbortController();
    const unbind = bindClientAbort(request, response, controller);
    response.emit("close");
    expect(controller.signal.aborted).toBe(true);
    unbind();
    expect(request.listenerCount("aborted")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });
});
