import type { CanonicalEvent } from "../../core/canonical-event.js";
import { AnthropicProtocolError } from "./decoder.js";

export type AnthropicWireEvent = Readonly<{ event: string; data: Record<string, unknown> }>;
function wire(event: string, data: Record<string, unknown>): AnthropicWireEvent { return { event, data }; }
function sse(event: AnthropicWireEvent): string { return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`; }

function contentBlock(type: "text" | "reasoning" | "redacted-reasoning" | "tool-call", event: Extract<CanonicalEvent, { type: "content-started" }>): Record<string, unknown> {
  if (type === "text") return { type: "text", text: "" };
  if (type === "reasoning") return { type: "thinking", thinking: "" };
  if (type === "redacted-reasoning") return { type: "redacted_thinking", data: "" };
  if (!event.toolCallId || !event.toolName) throw new AnthropicProtocolError("invalid_event", "Tool content requires an ID and name", 500);
  return { type: "tool_use", id: event.toolCallId, name: event.toolName, input: {} };
}

/** Converts the canonical stream without exposing provider-specific events. */
export function encodeAnthropicEvents(events: readonly CanonicalEvent[], final = true): AnthropicWireEvent[] {
  const result: AnthropicWireEvent[] = [];
  let lastSequence = -1;
  let requestId: string | undefined;
  // #119: block index -> content type so `signature_delta` can fail closed on
  // a non-thinking block instead of emitting a signature that the aggregate
  // would silently drop.
  const open = new Map<number, "text" | "reasoning" | "redacted-reasoning" | "tool-call">();
  for (const item of events) {
    if (item.sequence <= lastSequence) throw new AnthropicProtocolError("invalid_event_sequence", "Canonical event sequence is not monotonic", 500);
    if (requestId && item.requestId !== requestId) throw new AnthropicProtocolError("invalid_event_provenance", "Canonical events have mixed provenance", 500);
    requestId ??= item.requestId; lastSequence = item.sequence;
    switch (item.type) {
      case "response-started": result.push(wire("message_start", { type: "message_start", message: { id: item.responseId, type: "message", role: "assistant", content: [], model: item.modelId, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })); break;
      case "content-started": open.set(item.index, item.contentType); result.push(wire("content_block_start", { type: "content_block_start", index: item.index, content_block: contentBlock(item.contentType, item) })); break;
      case "text-delta": result.push(wire("content_block_delta", { type: "content_block_delta", index: item.index, delta: { type: "text_delta", text: item.text } })); break;
      case "reasoning-delta": result.push(wire("content_block_delta", { type: "content_block_delta", index: item.index, delta: { type: "thinking_delta", thinking: item.text } })); break;
      case "signature-delta":
        if (open.get(item.index) !== "reasoning") throw new AnthropicProtocolError("invalid_event_order", "Signature delta before content start or on a non-thinking block", 500);
        result.push(wire("content_block_delta", { type: "content_block_delta", index: item.index, delta: { type: "signature_delta", signature: item.signature } }));
        break;
      case "tool-arguments-delta": result.push(wire("content_block_delta", { type: "content_block_delta", index: item.index, delta: { type: "input_json_delta", partial_json: item.partialJson } })); break;
      case "content-completed": if (!open.delete(item.index)) throw new AnthropicProtocolError("invalid_event_order", "Content completed before start", 500); result.push(wire("content_block_stop", { type: "content_block_stop", index: item.index })); break;
      case "usage-updated": result.push(wire("message_delta", { type: "message_delta", delta: {}, usage: { input_tokens: item.inputTokens, output_tokens: item.outputTokens } })); break;
      case "response-completed": result.push(wire("message_delta", { type: "message_delta", delta: { stop_reason: item.stopReason, stop_sequence: null }, usage: {} })); result.push(wire("message_stop", { type: "message_stop" })); break;
      case "response-failed": result.push(wire("error", { type: "error", error: { type: item.code, message: "Gateway upstream failed" } })); break;
    }
  }
  if (final && open.size) throw new AnthropicProtocolError("invalid_event_order", "Response ended with open content", 500);
  return result;
}

export function encodeAnthropicSse(events: readonly CanonicalEvent[]): string { return encodeAnthropicEvents(events).map(sse).join(""); }

export function aggregateAnthropicEvents(events: readonly CanonicalEvent[]): Record<string, unknown> {
  encodeAnthropicEvents(events);
  const blocks = new Map<number, Record<string, unknown>>(); const toolJson = new Map<number, string>(); const signatures = new Map<number, string>(); let responseId = "msg_unknown"; let model = "unknown"; let stopReason: string | null = null; let usage: Record<string, number> = {};
  for (const item of events) {
    if (item.type === "response-started") { responseId = item.responseId; model = item.modelId; }
    if (item.type === "content-started") blocks.set(item.index, contentBlock(item.contentType, item));
    if (item.type === "text-delta") { const block = blocks.get(item.index); if (block?.type === "text") block.text = `${String(block.text)}${item.text}`; }
    if (item.type === "reasoning-delta") { const block = blocks.get(item.index); if (block?.type === "thinking") block.thinking = `${String(block.thinking)}${item.text}`; }
    if (item.type === "signature-delta") signatures.set(item.index, item.signature);
    if (item.type === "tool-arguments-delta") toolJson.set(item.index, `${toolJson.get(item.index) ?? ""}${item.partialJson}`);
    if (item.type === "usage-updated") usage = { ...usage, ...(item.inputTokens === undefined ? {} : { input_tokens: item.inputTokens }), ...(item.outputTokens === undefined ? {} : { output_tokens: item.outputTokens }) };
    if (item.type === "response-completed") stopReason = item.stopReason;
    if (item.type === "response-failed") throw new AnthropicProtocolError(item.code, item.message, 502);
  }
  for (const [index, text] of toolJson) { const block = blocks.get(index); if (block) { try { block.input = JSON.parse(text); } catch { throw new AnthropicProtocolError("invalid_tool_arguments", "Tool argument deltas are not valid JSON", 502); } } }
  for (const [index, signature] of signatures) { const block = blocks.get(index); if (block?.type === "thinking") block.signature = signature; }
  return { id: responseId, type: "message", role: "assistant", content: [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block), model, stop_reason: stopReason, stop_sequence: null, usage };
}
