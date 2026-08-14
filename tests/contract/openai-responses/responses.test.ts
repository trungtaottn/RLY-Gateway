import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "../../../src/core/canonical-event.js";
import { FakeCanonicalUpstream } from "../../../src/protocols/anthropic/fake-upstream.js";
import { ResponseContinuationStore } from "../../../src/protocols/openai-responses/continuation.js";
import { decodeResponsesRequest, ResponsesProtocolError } from "../../../src/protocols/openai-responses/decoder.js";
import { aggregateResponsesEvents, encodeResponsesSse } from "../../../src/protocols/openai-responses/encoder.js";
import { bindClientAbort } from "../../../src/routes/anthropic-messages-route.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

const body = {
  model: "fixture-model",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "redacted fixture" }] }],
  tools: [{ type: "function", name: "fixture_tool", parameters: { type: "object" } }],
  stream: true,
};

describe("OpenAI Responses protocol", () => {
  it("loss-aware decodes items and declares requirements", () => {
    const decoded = decodeResponsesRequest(body, { "openai-version": "2026-01-01" });
    expect(decoded.request.source).toEqual({ protocol: "openai-responses", protocolVersion: "2026-01-01" });
    expect(decoded.request.input.map((item) => item.type)).toEqual(["text"]);
    expect(decoded.required).toEqual(["streaming", "tools"]);
  });

  it("preserves function output, reasoning, and continuation identity", () => {
    const decoded = decodeResponsesRequest({
      model: "fixture-model",
      previous_response_id: "resp_fixture",
      reasoning: { effort: "medium" },
      input: [
        { type: "function_call", call_id: "call_fixture", name: "fixture_tool", arguments: "{}" },
        { type: "function_call_output", call_id: "call_fixture", output: "fixture result" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "fixture reason" }] },
      ],
    });
    expect(decoded.request.continuation).toEqual({ previousResponseId: "resp_fixture" });
    expect(decoded.request.messages.map((message) => message.content[0]?.type)).toEqual(["tool-call", "tool-result", "reasoning"]);
    expect(decoded.required).toContain("reasoning");
    // #70: native effort is preserved, never collapsed into a bare boolean.
    expect(decoded.request.inference.reasoning).toEqual({ intent: "BALANCED", sourceEffort: "medium", explicit: true });
  });

  it("golden-streams Responses item events without Anthropic flattening", async () => {
    const decoded = decodeResponsesRequest({ model: "fixture-model", input: "fixture", stream: true });
    const events = await collect(new FakeCanonicalUpstream().invoke(decoded.request, new AbortController().signal));
    expect(encodeResponsesSse(events)).toBe([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"msg_fake","object":"response","status":"in_progress","model":"fixture-model","output":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"msg_fake","object":"response","status":"in_progress","model":"fixture-model","output":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_0","role":"assistant","status":"in_progress","content":[]}}\n\n',
      'event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"synthetic response"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"msg_fake","object":"response","status":"completed","model":"fixture-model","output":[{"type":"message","id":"msg_0","role":"assistant","status":"completed","content":[{"type":"output_text","text":"synthetic response"}]}],"usage":{"input_tokens":12,"output_tokens":4}}}\n\n',
    ].join(""));
  });

  it("aggregates function-call arguments without changing semantics", async () => {
    const decoded = decodeResponsesRequest({ ...body, input: "fixture", stream: false });
    const events = await collect(new FakeCanonicalUpstream("tool").invoke(decoded.request, new AbortController().signal));
    expect(aggregateResponsesEvents(events)).toMatchObject({
      id: "msg_fake",
      object: "response",
      output: [{ type: "function_call", call_id: "fixture-tool", name: "fixture_tool", arguments: "{\"unit\":\"fixture\"}" }],
      usage: { input_tokens: 12, output_tokens: 4 },
    });
  });

  it("marks unknown required items unready and rejects mixed provenance", () => {
    expect(() => decodeResponsesRequest({ model: "fixture-model", input: [{ type: "web_search_call" }] })).toThrow(ResponsesProtocolError);
    expect(() => decodeResponsesRequest({ model: "fixture-model", include: ["file_search_results"] })).toThrow(/Unsupported required include/);
    const request = decodeResponsesRequest({ model: "fixture-model", input: "fixture" }).request;
    const base = { requestId: request.id, timestamp: "2026-08-14T00:00:00.000Z", providerId: "fake", modelId: "fixture-model" };
    const events: CanonicalEvent[] = [
      { ...base, sequence: 0, type: "response-started", responseId: "resp_fixture" },
      { ...base, sequence: 1, type: "content-started", index: 0, contentType: "text" },
      { ...base, sequence: 2, type: "text-delta", index: 0, text: "synthetic" },
      { ...base, sequence: 3, type: "content-completed", index: 0 },
      { ...base, sequence: 4, type: "response-completed", stopReason: "end_turn" },
    ];
    expect(() => aggregateResponsesEvents([{ ...base, requestId: "other", sequence: 0, type: "response-started", responseId: "resp_fixture" }, ...events.slice(1)])).toThrow("mixed provenance");
  });

  it("applies continuation and refuses an unknown previous_response_id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-responses-"));
    try {
      const store = new ResponseContinuationStore(directory);
      await store.put({
        id: "resp_fixture",
        createdAt: "2026-08-14T00:00:00.000Z",
        model: "fixture-model",
        messages: [{ role: "assistant", content: [{ type: "text", text: "prior fixture" }] }],
      });
      const decoded = decodeResponsesRequest({ model: "fixture-model", previous_response_id: "resp_fixture", input: "next fixture" });
      const continued = await store.apply(decoded.request);
      expect(continued.messages[0]?.content[0]).toMatchObject({ type: "text", text: "prior fixture" });
      const first = decodeResponsesRequest({ model: "fixture-model", input: "first fixture" });
      const events = await collect(new FakeCanonicalUpstream().invoke(first.request, new AbortController().signal));
      const remembered = await store.remember(first.request, events);
      expect(remembered?.messages.some((message) => message.role === "user")).toBe(true);
      expect(remembered?.messages.some((message) => message.role === "assistant")).toBe(true);
      await expect(store.apply(decodeResponsesRequest({ model: "fixture-model", previous_response_id: "resp_missing", input: "x" }).request)).rejects.toThrow(/unknown or expired/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Responses client disconnect cancellation", () => {
  it("aborts outbound work on response-side close", () => {
    const request = new EventEmitter();
    const response = new EventEmitter();
    const controller = new AbortController();
    const unbind = bindClientAbort(request, response, controller);
    response.emit("close");
    expect(controller.signal.aborted).toBe(true);
    unbind();
    expect(request.listenerCount("aborted")).toBe(0);
  });
});
