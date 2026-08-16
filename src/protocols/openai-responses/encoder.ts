import type { CanonicalEvent } from "../../core/canonical-event.js";
import { artifactValue, type OpaqueArtifact } from "../../core/fidelity.js";
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
  // #121: provider-assigned item ids survive onto the wire when the upstream
  // rail preserved them; otherwise a deterministic local id is fabricated.
  if (event.contentType === "text") {
    return { type: "message", id: event.itemId ?? itemId(event.index, "msg"), role: "assistant", status: "in_progress", content: [] };
  }
  if (event.contentType === "reasoning" || event.contentType === "redacted-reasoning") {
    return { type: "reasoning", id: event.itemId ?? itemId(event.index, "rs"), summary: [] };
  }
  if (!event.toolCallId || !event.toolName) {
    throw new ResponsesProtocolError("invalid_event", "Function call content requires an ID and name", 500);
  }
  return { type: "function_call", id: event.itemId ?? itemId(event.index, "fc"), call_id: event.toolCallId, name: event.toolName, arguments: "" };
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

/**
 * Incremental aggregate state for the Responses protocol (#120).
 *
 * `response.completed` carries the FULL aggregated output, so the encoder
 * retains the accumulated output projection (items, per-block text/reasoning/
 * tool-JSON strings, response id, model, usage) rather than the canonical
 * event history. Retained state is bounded by output size, never by event
 * count, and each event is applied exactly once.
 */
export type ResponsesAggregateState = Readonly<{
  items: ReadonlyMap<number, OutputItem>;
  toolJson: ReadonlyMap<number, string>;
  text: ReadonlyMap<number, string>;
  reasoning: ReadonlyMap<number, string>;
  responseId: string;
  model: string;
  usage: Record<string, number>;
  /** #121: opaque continuation artifacts discovered in the provider response. */
  artifacts: readonly OpaqueArtifact[];
}>;

type ResponsesAggregateContext = {
  items: Map<number, OutputItem>;
  toolJson: Map<number, string>;
  text: Map<number, string>;
  reasoning: Map<number, string>;
  responseId: string;
  model: string;
  usage: Record<string, number>;
  artifacts: OpaqueArtifact[];
};

function createAggregateContext(): ResponsesAggregateContext {
  return {
    items: new Map(),
    toolJson: new Map(),
    text: new Map(),
    reasoning: new Map(),
    responseId: "resp_unknown",
    model: "unknown",
    usage: { input_tokens: 0, output_tokens: 0 },
    artifacts: [],
  };
}

function applyAggregate(context: ResponsesAggregateContext, item: CanonicalEvent): void {
  if (item.type === "response-started") { context.responseId = item.responseId; context.model = item.modelId; }
  if (item.type === "content-started") context.items.set(item.index, startItem(item));
  if (item.type === "text-delta") appendDelta(context.text, item.index, item.text);
  if (item.type === "reasoning-delta") appendDelta(context.reasoning, item.index, item.text);
  if (item.type === "tool-arguments-delta") appendDelta(context.toolJson, item.index, item.partialJson);
  if (item.type === "usage-updated") context.usage = { input_tokens: item.inputTokens ?? 0, output_tokens: item.outputTokens ?? 0 };
  if (item.type === "fidelity-artifacts") context.artifacts.push(...item.artifacts);
}

/** Builds the final aggregated output from the retained aggregate state. */
function finalizeAggregate(context: ResponsesAggregateContext): Readonly<{
  id: string;
  model: string;
  output: OutputItem[];
  usage: Record<string, number>;
}> {
  for (const [index, value] of context.text) {
    const item = context.items.get(index);
    if (item?.type === "message") {
      item.content = [{ type: "output_text", text: value }];
      item.status = "completed";
    }
  }
  for (const [index, value] of context.reasoning) {
    const item = context.items.get(index);
    if (item?.type === "reasoning") item.summary = [{ type: "summary_text", text: value }];
  }
  // #121: provider-returned opaque artifacts (reasoning encrypted content)
  // attach to their owning reasoning item by association, never interpreted.
  for (const item of context.items.values()) {
    if (item.type !== "reasoning" || typeof item.id !== "string") continue;
    const envelope = { version: 1 as const, sourceProtocol: "openai-responses" as const, artifacts: context.artifacts, notes: [], required: [] };
    const encrypted = artifactValue(envelope, "openai-reasoning-encrypted-content", item.id);
    if (encrypted !== undefined) item.encrypted_content = encrypted;
  }
  for (const [index, value] of context.toolJson) {
    const item = context.items.get(index);
    if (item?.type === "function_call") {
      try { JSON.parse(value); } catch { throw new ResponsesProtocolError("invalid_tool_arguments", "Function argument deltas are not valid JSON", 502); }
      item.arguments = value;
    }
  }
  return {
    id: context.responseId,
    model: context.model,
    output: [...context.items.entries()].sort(([left], [right]) => left - right).map(([, item]) => item),
    usage: context.usage,
  };
}

function outputFromEvents(events: readonly CanonicalEvent[]): Readonly<{
  id: string;
  model: string;
  output: OutputItem[];
  usage: Record<string, number>;
}> {
  const context = createAggregateContext();
  for (const item of events) applyAggregate(context, item);
  return finalizeAggregate(context);
}

/** Converts the canonical stream into Responses SSE events without Anthropic flattening. */
export function encodeResponsesEvents(events: readonly CanonicalEvent[], final = true): ResponsesWireEvent[] {
  const context = createContext();
  const result: ResponsesWireEvent[] = [];
  for (const item of events) result.push(...encodeResponsesEvent(context, item));
  if (final) assertClosed(context);
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

type ResponsesEncodeContext = {
  lastSequence: number;
  requestId: string | undefined;
  open: Set<number>;
  aggregate: ResponsesAggregateContext;
  status: "idle" | "completed" | "failed";
};

function createContext(): ResponsesEncodeContext {
  return { lastSequence: -1, requestId: undefined, open: new Set(), aggregate: createAggregateContext(), status: "idle" };
}

/** Encodes exactly one canonical event and returns only its new wire frames. */
function encodeResponsesEvent(context: ResponsesEncodeContext, item: CanonicalEvent): ResponsesWireEvent[] {
  if (item.sequence <= context.lastSequence) throw new ResponsesProtocolError("invalid_event_sequence", "Canonical event sequence is not monotonic", 500);
  if (context.requestId && item.requestId !== context.requestId) throw new ResponsesProtocolError("invalid_event_provenance", "Canonical events have mixed provenance", 500);
  context.requestId ??= item.requestId;
  context.lastSequence = item.sequence;
  applyAggregate(context.aggregate, item);
  switch (item.type) {
    case "response-started":
      return [
        wire("response.created", { type: "response.created", response: responseRecord(context.aggregate.responseId, context.aggregate.model, "in_progress") }),
        wire("response.in_progress", { type: "response.in_progress", response: responseRecord(context.aggregate.responseId, context.aggregate.model, "in_progress") }),
      ];
    case "content-started": {
      context.open.add(item.index);
      const started = startItem(item);
      const frames: ResponsesWireEvent[] = [wire("response.output_item.added", { type: "response.output_item.added", output_index: item.index, item: started })];
      if (item.contentType === "text") {
        frames.push(wire("response.content_part.added", { type: "response.content_part.added", output_index: item.index, content_index: 0, part: { type: "output_text", text: "" } }));
      }
      return frames;
    }
    case "text-delta":
      return [wire("response.output_text.delta", { type: "response.output_text.delta", output_index: item.index, content_index: 0, delta: item.text })];
    case "reasoning-delta":
      return [wire("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", output_index: item.index, delta: item.text })];
    case "tool-arguments-delta":
      return [wire("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: item.index, delta: item.partialJson })];
    case "content-completed":
      if (!context.open.delete(item.index)) throw new ResponsesProtocolError("invalid_event_order", "Content completed before start", 500);
      return [wire("response.output_item.done", { type: "response.output_item.done", output_index: item.index })];
    case "usage-updated":
      return [];
    case "response-completed": {
      context.status = "completed";
      const aggregated = finalizeAggregate(context.aggregate);
      return [wire("response.completed", {
        type: "response.completed",
        response: { id: context.aggregate.responseId, object: "response", status: "completed", model: context.aggregate.model, output: aggregated.output, usage: context.aggregate.usage },
      })];
    }
    case "response-failed":
      context.status = "failed";
      // #121: the canonical failed event's code/message are adapter-safe
      // (allowlisted provider error fields), so they survive to the wire
      // instead of generic normalization.
      return [wire("response.failed", { type: "response.failed", response: { id: context.aggregate.responseId, object: "response", status: "failed", error: { code: item.code, message: item.message } } })];
    case "signature-delta":
      // Anthropic-only fidelity event; a Responses stream never carries it.
      // Preserve legacy wire-equivalence: no frame is produced for it.
      return [];
    case "fidelity-artifacts":
      // Opaque artifacts attach to the terminal aggregate only; no wire frame.
      return [];
    default:
      // Exhaustive safety net: unknown event kinds produce no frame.
      return [];
  }
}

function assertClosed(context: ResponsesEncodeContext): void {
  if (context.open.size) throw new ResponsesProtocolError("invalid_event_order", "Response ended with open content", 500);
}

/**
 * Incremental per-stream encoder (#120): consumes one canonical event at a
 * time and emits ONLY the wire frames that event produces. `finish()` must be
 * called on a clean stream end to validate terminal protocol state (no open
 * output items); it throws on a malformed completion, exactly like the batch
 * encoder with `final = true`.
 */
export interface ResponsesIncrementalEncoder {
  push(event: CanonicalEvent): ResponsesWireEvent[];
  finish(): void;
  /** "idle" | "completed" | "failed" — terminal fidelity state of the stream. */
  status(): "idle" | "completed" | "failed";
  /** Final aggregated response; valid only when status() === "completed". */
  aggregate(): Readonly<{ id: string; model: string; output: readonly OutputItem[]; usage: Record<string, number> }>;
  /** Number of retained protocol-state entries (open items + aggregate projection). */
  retainedStateSize(): number;
}

export function createResponsesIncrementalEncoder(): ResponsesIncrementalEncoder {
  const context = createContext();
  return {
    push: (event) => encodeResponsesEvent(context, event),
    finish: () => assertClosed(context),
    status: () => context.status,
    aggregate: () => finalizeAggregate(context.aggregate),
    retainedStateSize: () => context.open.size + context.aggregate.items.size + context.aggregate.text.size + context.aggregate.reasoning.size + context.aggregate.toolJson.size,
  };
}
