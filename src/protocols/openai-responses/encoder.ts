import type { CanonicalEvent } from "../../core/canonical-event.js";
import { ResponsesProtocolError } from "./decoder.js";

export type ResponsesWireEvent = Readonly<{ event: string; data: Record<string, unknown> }>;

function wire(event: string, data: Record<string, unknown>): ResponsesWireEvent {
  return { event, data };
}

function sse(event: ResponsesWireEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

type OutputItem = Record<string, unknown>;

function itemId(index: number, prefix: string): string {
  return `${prefix}_${String(index)}`;
}

function startItem(event: Extract<CanonicalEvent, { type: "content-started" }>): OutputItem {
  if (event.contentType === "text") {
    return { type: "message", id: itemId(event.index, "msg"), role: "assistant", status: "in_progress", content: [] };
  }
  if (event.contentType === "reasoning" || event.contentType === "redacted-reasoning") {
    return { type: "reasoning", id: itemId(event.index, "rs"), summary: [] };
  }
  if (!event.toolCallId || !event.toolName) {
    throw new ResponsesProtocolError("invalid_event", "Function call content requires an ID and name", 500);
  }
  return { type: "function_call", id: itemId(event.index, "fc"), call_id: event.toolCallId, name: event.toolName, arguments: "" };
}

function responseRecord(
  id: string,
  model: string,
  status: string,
  usage: Record<string, number> = { input_tokens: 0, output_tokens: 0 },
): Record<string, unknown> {
  return { id, object: "response", status, model, output: [], usage };
}

function appendDelta(map: Map<number, string>, index: number, delta: string): void {
  map.set(index, `${map.get(index) ?? ""}${delta}`);
}

function outputFromEvents(events: readonly CanonicalEvent[]): Readonly<{
  id: string;
  model: string;
  output: OutputItem[];
  usage: Record<string, number>;
}> {
  const items = new Map<number, OutputItem>();
  const toolJson = new Map<number, string>();
  const text = new Map<number, string>();
  const reasoning = new Map<number, string>();
  let responseId = "resp_unknown";
  let model = "unknown";
  let usage: Record<string, number> = { input_tokens: 0, output_tokens: 0 };
  for (const item of events) {
    if (item.type === "response-started") { responseId = item.responseId; model = item.modelId; }
    if (item.type === "content-started") items.set(item.index, startItem(item));
    if (item.type === "text-delta") appendDelta(text, item.index, item.text);
    if (item.type === "reasoning-delta") appendDelta(reasoning, item.index, item.text);
    if (item.type === "tool-arguments-delta") appendDelta(toolJson, item.index, item.partialJson);
    if (item.type === "usage-updated") usage = { input_tokens: item.inputTokens ?? 0, output_tokens: item.outputTokens ?? 0 };
  }
  for (const [index, value] of text) {
    const item = items.get(index);
    if (item?.type === "message") {
      item.content = [{ type: "output_text", text: value }];
      item.status = "completed";
    }
  }
  for (const [index, value] of reasoning) {
    const item = items.get(index);
    if (item?.type === "reasoning") item.summary = [{ type: "summary_text", text: value }];
  }
  for (const [index, value] of toolJson) {
    const item = items.get(index);
    if (item?.type === "function_call") {
      try { JSON.parse(value); } catch { throw new ResponsesProtocolError("invalid_tool_arguments", "Function argument deltas are not valid JSON", 502); }
      item.arguments = value;
    }
  }
  return {
    id: responseId,
    model,
    output: [...items.entries()].sort(([left], [right]) => left - right).map(([, item]) => item),
    usage,
  };
}

/** Converts the canonical stream into Responses SSE events without Anthropic flattening. */
export function encodeResponsesEvents(events: readonly CanonicalEvent[], final = true): ResponsesWireEvent[] {
  const result: ResponsesWireEvent[] = [];
  let lastSequence = -1;
  let requestId: string | undefined;
  let responseId = "resp_unknown";
  let model = "unknown";
  const open = new Set<number>();
  let usage: Record<string, number> = { input_tokens: 0, output_tokens: 0 };
  for (const item of events) {
    if (item.sequence <= lastSequence) throw new ResponsesProtocolError("invalid_event_sequence", "Canonical event sequence is not monotonic", 500);
    if (requestId && item.requestId !== requestId) throw new ResponsesProtocolError("invalid_event_provenance", "Canonical events have mixed provenance", 500);
    requestId ??= item.requestId;
    lastSequence = item.sequence;
    switch (item.type) {
      case "response-started":
        responseId = item.responseId;
        model = item.modelId;
        result.push(wire("response.created", { type: "response.created", response: responseRecord(responseId, model, "in_progress") }));
        result.push(wire("response.in_progress", { type: "response.in_progress", response: responseRecord(responseId, model, "in_progress") }));
        break;
      case "content-started": {
        open.add(item.index);
        const started = startItem(item);
        result.push(wire("response.output_item.added", { type: "response.output_item.added", output_index: item.index, item: started }));
        if (item.contentType === "text") {
          result.push(wire("response.content_part.added", { type: "response.content_part.added", output_index: item.index, content_index: 0, part: { type: "output_text", text: "" } }));
        }
        break;
      }
      case "text-delta":
        result.push(wire("response.output_text.delta", { type: "response.output_text.delta", output_index: item.index, content_index: 0, delta: item.text }));
        break;
      case "reasoning-delta":
        result.push(wire("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", output_index: item.index, delta: item.text }));
        break;
      case "tool-arguments-delta":
        result.push(wire("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: item.index, delta: item.partialJson }));
        break;
      case "content-completed":
        if (!open.delete(item.index)) throw new ResponsesProtocolError("invalid_event_order", "Content completed before start", 500);
        result.push(wire("response.output_item.done", { type: "response.output_item.done", output_index: item.index }));
        break;
      case "usage-updated":
        usage = { input_tokens: item.inputTokens ?? 0, output_tokens: item.outputTokens ?? 0 };
        break;
      case "response-completed": {
        const aggregated = outputFromEvents(events);
        result.push(wire("response.completed", {
          type: "response.completed",
          response: { id: responseId, object: "response", status: "completed", model, output: aggregated.output, usage },
        }));
        break;
      }
      case "response-failed":
        result.push(wire("response.failed", { type: "response.failed", response: { id: responseId, object: "response", status: "failed", error: { code: item.code, message: "Gateway upstream failed" } } }));
        break;
    }
  }
  if (final && open.size) throw new ResponsesProtocolError("invalid_event_order", "Response ended with open content", 500);
  return result;
}

export function encodeResponsesSse(events: readonly CanonicalEvent[]): string {
  return encodeResponsesEvents(events).map(sse).join("");
}

export function aggregateResponsesEvents(events: readonly CanonicalEvent[]): Record<string, unknown> {
  encodeResponsesEvents(events);
  const failed = events.find((item): item is Extract<CanonicalEvent, { type: "response-failed" }> => item.type === "response-failed");
  if (failed) throw new ResponsesProtocolError(failed.code, failed.message, 502);
  const aggregated = outputFromEvents(events);
  return {
    id: aggregated.id,
    object: "response",
    status: "completed",
    model: aggregated.model,
    output: aggregated.output,
    usage: aggregated.usage,
  };
}
