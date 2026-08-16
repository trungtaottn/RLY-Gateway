import type { CanonicalContent, CanonicalRequest } from "../../core/canonical-request.js";
import type { CanonicalEvent } from "../../core/canonical-event.js";
import { artifactValue, unsupportedRequiredArtifacts, type OpaqueArtifact } from "../../core/fidelity.js";
import type { ResolvedReasoning } from "../../core/reasoning.js";
import type { RouteDecision } from "../../core/route-decision.js";
import { resolveEnvironmentCredential, type SecretHandle } from "../../credentials/env-resolver.js";
import type { CommitmentState } from "../commitment.js";
import {
  commitmentForHttpFailure,
  parseProviderError,
  type ProviderErrorInfo,
} from "../provider-error.js";
import { ProviderAdapterError, type ProviderAdapter, type ProviderProbe } from "../provider-adapter.js";

type Fetch = typeof fetch;

const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;
const CONNECTION_LEVEL_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ECONNRESET"]);
const RESPONSES_EFFORT_LEVELS = new Set(["none", "low", "medium", "high"]);

/**
 * True OpenAI Responses upstream rail (#121).
 *
 * A first-class Responses request/stream path — NOT Chat-Completions-like
 * semantics. It wires the Responses item vocabulary (message/function_call/
 * function_call_output/reasoning) onto the shared canonical request, preserves
 * item identity (`item.id`), continuation fields (`previous_response_id`,
 * response id), tool/reasoning item ordering, and #119 opaque artifacts
 * (reasoning `encrypted_content`) through provider invocation.
 *
 * Exact endpoint contract: `POST {endpoint}/responses` with the OpenAI
 * Responses wire shape (streaming via `event:`/`data:` SSE frames). This is a
 * DIFFERENT, exact contract from Chat Completions; adapters that do not
 * implement it keep the cross-protocol translation path.
 *
 * PRIVACY INVARIANT: all error surfaces carry only allowlisted provider error
 * fields; opaque artifact values are protocol state, never diagnostics.
 */
export class OpenAiResponsesAdapter implements ProviderAdapter {
  readonly id = "openai-responses-direct";
  constructor(
    private readonly request: Fetch = fetch,
    protected readonly endpoint: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  ) {}

  protected get requestEndpoint(): string {
    return this.endpoint.replace(/\/$/, "") + "/responses";
  }

  protected ownsSecret = true;
  protected resolveSecret(decision: RouteDecision): SecretHandle {
    return resolveEnvironmentCredential(decision.credentialRef, this.environment);
  }

  private async post(request: CanonicalRequest, decision: RouteDecision, signal: AbortSignal): Promise<Response> {
    const secret = this.resolveSecret(decision);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.request(this.requestEndpoint, {
        method: "POST",
        signal: AbortSignal.any([signal, timeout]),
        headers: {
          authorization: `Bearer ${secret.reveal()}`,
          "content-type": "application/json",
          accept: request.stream ? "text/event-stream" : "application/json",
        },
        body: JSON.stringify(this.responsesPayload(request, decision.resolvedReasoning)),
      });
      return response;
    } catch (error) {
      if (timeout.aborted && !signal.aborted) {
        // The request may have been accepted and processed server-side; the
        // outcome is unknown → conservative no-replay.
        throw new ProviderAdapterError("timeout_error", "Provider request timed out", undefined, "unknown");
      }
      // Connection-level failures (DNS/refused/unreachable) prove the request
      // never reached the provider; anything else after send is ambiguous.
      const code = (error as { cause?: { code?: string } }).cause?.code;
      const commitment: CommitmentState = typeof code === "string" && CONNECTION_LEVEL_CODES.has(code) ? "not-sent" : "unknown";
      throw new ProviderAdapterError("api_error", "Provider request failed", undefined, commitment);
    } finally {
      if (this.ownsSecret) secret.dispose();
    }
  }

  /** #119 fail-closed fidelity: the native rail preserves Responses encrypted content only. */
  protected unsupportedRequired(request: CanonicalRequest): OpaqueArtifact["kind"][] {
    return unsupportedRequiredArtifacts(request.fidelity, ["openai-reasoning-encrypted-content"]);
  }

  protected responsesPayload(request: CanonicalRequest, reasoning?: ResolvedReasoning): Record<string, unknown> {
    return {
      model: request.requestedModel,
      input: responsesInput(request),
      ...(request.system.length === 0 ? {} : { instructions: textOf(request.system) }),
      ...(request.tools.length === 0 ? {} : { tools: request.tools.map((tool) => ({ type: "function", name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), ...(Object.keys(tool.inputSchema).length === 0 ? {} : { parameters: tool.inputSchema }) })) }),
      ...(request.toolChoice === undefined ? {} : { tool_choice: toolChoiceOf(request.toolChoice) }),
      stream: request.stream,
      ...(request.continuation === undefined ? {} : { previous_response_id: request.continuation.previousResponseId }),
      ...(request.inference.maxOutputTokens === undefined ? {} : { max_output_tokens: request.inference.maxOutputTokens }),
      ...(request.inference.temperature === undefined ? {} : { temperature: request.inference.temperature }),
      ...(request.inference.topP === undefined ? {} : { top_p: request.inference.topP }),
      ...this.reasoningPayload(request, reasoning),
      ...(request.fidelity === undefined || request.fidelity.artifacts.length === 0 ? {} : { include: ["reasoning.encrypted_content"] }),
    };
  }

  /**
   * Native Responses `reasoning` control from the #70 translation result.
   * Explicit source effort labels in the Responses vocabulary pass through
   * exactly; other intents map deterministically to the nearest reviewed
   * level. Never invents a level the evidence did not provide.
   */
  protected reasoningPayload(request: CanonicalRequest, resolved: ResolvedReasoning | undefined): Record<string, unknown> {
    if (request.inference.reasoning?.explicit === true && request.inference.reasoning.sourceEffort !== undefined && RESPONSES_EFFORT_LEVELS.has(request.inference.reasoning.sourceEffort)) {
      return { reasoning: { effort: request.inference.reasoning.sourceEffort } };
    }
    if (resolved === undefined) return {};
    switch (resolved.effective.kind) {
      case "off":
        return { reasoning: { effort: "none" } };
      case "provider-default":
        return {};
      case "binary":
        return resolved.effective.enabled ? { reasoning: { effort: "medium" } } : { reasoning: { effort: "none" } };
      case "effort":
        return { reasoning: { effort: RESPONSES_EFFORT_LEVELS.has(resolved.effective.level) ? resolved.effective.level : "medium" } };
      case "adaptive":
        return resolved.effective.enabled ? { reasoning: { effort: "medium" } } : {};
      case "budget":
        return { reasoning: { effort: "medium" } };
    }
  }

  async *invoke(request: CanonicalRequest, decision: RouteDecision, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
    const unsupported = this.unsupportedRequired(request);
    if (unsupported.length > 0) {
      throw new ProviderAdapterError("unsupported-fidelity", `The Responses rail cannot preserve required continuation artifact: ${unsupported.join(", ")}`);
    }
    const response = await this.post(request, decision, signal);
    if (!response.ok) {
      const info = await parseProviderError(response);
      throw new ProviderAdapterError(info.code, info.message, info, commitmentForHttpFailure(response));
    }
    let commitment: CommitmentState = "provider-accepted";
    const state: RailState = { sequence: 0, started: false, open: new Set(), toolNames: new Map(), artifacts: [] };
    const fail = (code: string, message: string, info?: ProviderErrorInfo): never => {
      throw new ProviderAdapterError(code, message, info, commitment);
    };
    if (!request.stream) {
      yield* this.decodeNonStreaming(request, decision, response, state, commitment, fail);
      return;
    }
    const bodyStream = response.body;
    if (bodyStream === null) {
      fail("api_error", "Provider stream has no body", { statusCode: 502, code: "api_error", message: "Provider stream has no body" });
      return;
    }
    for await (const frame of sseFrames(bodyStream)) {
      if ("error" in frame) fail("api_error", "Provider returned a malformed stream frame");
      const wire = frame as Readonly<{ event?: string; data: Readonly<Record<string, unknown>> }>;
      const type = String(wire.data.type ?? wire.event ?? "");
      switch (type) {
        case "response.created":
        case "response.in_progress": {
          if (!state.started) {
            const responseObj = record(wire.data.response);
            const responseId = typeof responseObj?.id === "string" ? responseObj.id : "provider-response";
            state.started = true;
            yield this.event(request, decision, state, "response-started", { responseId });
          }
          break;
        }
        case "response.output_item.added": {
          const item = record(wire.data.item);
          const index = numberOr(wire.data.output_index, state.open.size);
          state.open.add(index);
          const itemId = typeof item?.id === "string" ? item.id : undefined;
          const itemType = typeof item?.type === "string" ? item.type : "message";
          if (itemType === "message") {
            yield this.event(request, decision, state, "content-started", { index, contentType: "text", ...(itemId === undefined ? {} : { itemId }) });
            for (const part of contentParts(item?.content)) {
              if (part.type === "output_text" && part.text) yield this.event(request, decision, state, "text-delta", { index, text: part.text });
            }
          } else if (itemType === "reasoning") {
            yield this.event(request, decision, state, "content-started", { index, contentType: "reasoning", ...(itemId === undefined ? {} : { itemId }) });
            captureReasoningArtifact(state, item);
            for (const part of reasoningSummary(item)) yield this.event(request, decision, state, "reasoning-delta", { index, text: part });
          } else if (itemType === "function_call") {
            commitment = "tool-boundary";
            const callId = typeof item?.call_id === "string" ? item.call_id : itemId ?? `tool-${index}`;
            const name = typeof item?.name === "string" ? item.name : "tool";
            state.toolNames.set(index, name);
            yield this.event(request, decision, state, "content-started", { index, contentType: "tool-call", toolCallId: callId, toolName: name, ...(itemId === undefined ? {} : { itemId }) });
            const args = typeof item?.arguments === "string" ? item.arguments : "";
            if (args) yield this.event(request, decision, state, "tool-arguments-delta", { index, toolCallId: callId, partialJson: args });
          }
          break;
        }
        case "response.content_part.added":
          // The output item already emitted its parts; nothing new to encode.
          break;
        case "response.output_text.delta": {
          const index = numberOr(wire.data.output_index, 0);
          if (!state.open.has(index)) { state.open.add(index); yield this.event(request, decision, state, "content-started", { index, contentType: "text" }); }
          if (typeof wire.data.delta === "string") yield this.event(request, decision, state, "text-delta", { index, text: wire.data.delta });
          break;
        }
        case "response.reasoning_summary_text.delta": {
          const index = numberOr(wire.data.output_index, 0);
          if (!state.open.has(index)) { state.open.add(index); yield this.event(request, decision, state, "content-started", { index, contentType: "reasoning" }); }
          if (typeof wire.data.delta === "string") yield this.event(request, decision, state, "reasoning-delta", { index, text: wire.data.delta });
          break;
        }
        case "response.function_call_arguments.delta": {
          const index = numberOr(wire.data.output_index, 0);
          const name = state.toolNames.get(index) ?? "tool";
          const callId = typeof wire.data.item_id === "string" ? wire.data.item_id : `tool-${index}`;
          if (!state.open.has(index)) { state.open.add(index); commitment = "tool-boundary"; yield this.event(request, decision, state, "content-started", { index, contentType: "tool-call", toolCallId: callId, toolName: name }); }
          if (typeof wire.data.delta === "string") yield this.event(request, decision, state, "tool-arguments-delta", { index, toolCallId: callId, partialJson: wire.data.delta });
          break;
        }
        case "response.output_item.done": {
          const index = numberOr(wire.data.output_index, 0);
          if (state.open.delete(index)) yield this.event(request, decision, state, "content-completed", { index });
          break;
        }
        case "response.completed": {
          const responseObj = record(wire.data.response);
          for (const item of outputItems(responseObj)) captureReasoningArtifact(state, item);
          if (state.artifacts.length > 0) {
            yield this.event(request, decision, state, "fidelity-artifacts", { artifacts: [...state.artifacts] });
            state.artifacts = [];
          }
          const usage = record(responseObj?.usage);
          yield this.event(request, decision, state, "usage-updated", {
            ...(usage === undefined || typeof usage.input_tokens !== "number" ? {} : { inputTokens: usage.input_tokens }),
            ...(usage === undefined || typeof usage.output_tokens !== "number" ? {} : { outputTokens: usage.output_tokens }),
          });
          yield this.event(request, decision, state, "response-completed", { stopReason: stopReasonOf(responseObj) });
          state.started = true;
          break;
        }
        case "response.failed": {
          const responseObj = record(wire.data.response);
          for (const item of outputItems(responseObj)) captureReasoningArtifact(state, item);
          if (state.artifacts.length > 0) {
            yield this.event(request, decision, state, "fidelity-artifacts", { artifacts: [...state.artifacts] });
            state.artifacts = [];
          }
          const err = record(responseObj?.error) ?? record(responseObj);
          const code = typeof err?.code === "string" ? err.code : typeof err?.type === "string" ? err.type : "api_error";
          const message = typeof err?.message === "string" ? err.message : "Provider response failed";
          fail(code, message, { statusCode: 502, code, ...(typeof err?.type === "string" ? { type: err.type } : {}), message });
          break;
        }
        case "error": {
          const err = record(wire.data.error) ?? wire.data;
          const code = typeof err?.code === "string" ? err.code : typeof err?.type === "string" ? err.type : "api_error";
          const message = typeof err?.message === "string" ? err.message : "Provider stream error";
          fail(code, message, { statusCode: 502, code, ...(typeof err?.type === "string" ? { type: err.type } : {}), message });
          break;
        }
        default:
          // Additive unknown stream events are ignored (never fail on them).
          break;
      }
    }
    if (!state.started) fail("api_error", "Provider stream ended before a response started");
  }

  private async *decodeNonStreaming(
    request: CanonicalRequest,
    decision: RouteDecision,
    response: Response,
    state: RailState,
    commitment: CommitmentState,
    fail: (code: string, message: string, info?: ProviderErrorInfo) => never,
  ): AsyncGenerator<CanonicalEvent> {
    void commitment;
    let body: Readonly<Record<string, unknown>>;
    try {
      const parsed = await response.json() as unknown;
      body = record(parsed) ?? {};
    } catch {
      fail("api_error", "Provider returned a malformed response body", { statusCode: 502, code: "api_error", message: "Provider returned a malformed response body" });
      return;
    }
    const responseId = typeof body.id === "string" ? body.id : "provider-response";
    state.started = true;
    yield this.event(request, decision, state, "response-started", { responseId });
    let index = 0;
    for (const item of outputItems(body)) {
      const itemId = typeof item?.id === "string" ? item.id : undefined;
      if (item?.type === "message") {
        yield this.event(request, decision, state, "content-started", { index, contentType: "text", ...(itemId === undefined ? {} : { itemId }) });
        for (const part of contentParts(item.content)) if (part.type === "output_text" && part.text) yield this.event(request, decision, state, "text-delta", { index, text: part.text });
        yield this.event(request, decision, state, "content-completed", { index });
      } else if (item?.type === "reasoning") {
        yield this.event(request, decision, state, "content-started", { index, contentType: "reasoning", ...(itemId === undefined ? {} : { itemId }) });
        captureReasoningArtifact(state, item);
        for (const part of reasoningSummary(item)) yield this.event(request, decision, state, "reasoning-delta", { index, text: part });
        yield this.event(request, decision, state, "content-completed", { index });
      } else if (item?.type === "function_call") {
        const callId = typeof item.call_id === "string" ? item.call_id : itemId ?? `tool-${index}`;
        const name = typeof item.name === "string" ? item.name : "tool";
        yield this.event(request, decision, state, "content-started", { index, contentType: "tool-call", toolCallId: callId, toolName: name, ...(itemId === undefined ? {} : { itemId }) });
        if (typeof item.arguments === "string" && item.arguments) yield this.event(request, decision, state, "tool-arguments-delta", { index, toolCallId: callId, partialJson: item.arguments });
        yield this.event(request, decision, state, "content-completed", { index });
      }
      index += 1;
    }
    if (state.artifacts.length > 0) {
      yield this.event(request, decision, state, "fidelity-artifacts", { artifacts: [...state.artifacts] });
      state.artifacts = [];
    }
    const usage = record(body.usage);
    yield this.event(request, decision, state, "usage-updated", {
      ...(usage === undefined || typeof usage.input_tokens !== "number" ? {} : { inputTokens: usage.input_tokens }),
      ...(usage === undefined || typeof usage.output_tokens !== "number" ? {} : { outputTokens: usage.output_tokens }),
    });
    yield this.event(request, decision, state, "response-completed", { stopReason: stopReasonOf(body) });
  }

  private event(request: CanonicalRequest, decision: RouteDecision, state: RailState, type: CanonicalEvent["type"], data: object): CanonicalEvent {
    return { requestId: request.id, sequence: state.sequence++, timestamp: new Date().toISOString(), providerId: decision.providerId, modelId: decision.modelId, type, ...data } as CanonicalEvent;
  }

  async probe(decision: RouteDecision, signal: AbortSignal): Promise<ProviderProbe> {
    const secret = this.resolveSecret(decision);
    try {
      const response = await this.request(`${this.endpoint.replace(/\/$/, "")}/models`, { signal, headers: { authorization: `Bearer ${secret.reveal()}` } });
      if (!response.ok) return { providerId: decision.providerId, modelId: decision.modelId, readiness: response.status === 401 || response.status === 403 ? "unauthenticated" : "unavailable", checkedAt: new Date().toISOString() };
      const catalog = await response.json() as { data?: unknown };
      const exists = Array.isArray(catalog.data) && catalog.data.some((item) => Boolean(item) && typeof item === "object" && (item as { id?: unknown }).id === decision.modelId);
      return { providerId: decision.providerId, modelId: decision.modelId, readiness: exists ? "ready" : "unavailable", ...(exists ? { capabilities: decision.capabilitySnapshot } : {}), checkedAt: new Date().toISOString() };
    } finally {
      if (this.ownsSecret) secret.dispose();
    }
  }
}

type RailState = {
  sequence: number;
  started: boolean;
  open: Set<number>;
  toolNames: Map<number, string>;
  artifacts: OpaqueArtifact[];
};

function textOf(content: readonly CanonicalContent[]): string {
  return content.filter((item): item is Extract<CanonicalContent, { type: "text" }> => item.type === "text").map((item) => item.text).join("\n");
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toolChoiceOf(choice: CanonicalRequest["toolChoice"]): unknown {
  if (choice === undefined) return undefined;
  switch (choice.type) {
    case "auto":
    case "none":
      return choice.type;
    case "any":
      return "required";
    case "tool":
      return { type: "function", name: choice.name };
  }
}

function contentParts(content: unknown): readonly Readonly<{ type: string; text?: unknown }>[] {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is Readonly<{ type: string; text?: unknown }> => Boolean(part) && typeof part === "object" && typeof (part as { type?: unknown }).type === "string");
}

function reasoningSummary(item: Readonly<Record<string, unknown>> | undefined): string[] {
  if (item === undefined || !Array.isArray(item.summary)) return [];
  return item.summary.flatMap((part) => {
    const text = record(part)?.text;
    return typeof text === "string" && text.length > 0 ? [text] : [];
  });
}

/** #119: reasoning `encrypted_content` rides the fidelity envelope by item id. */
function captureReasoningArtifact(state: RailState, item: Readonly<Record<string, unknown>> | undefined): void {
  if (item === undefined || item.type !== "reasoning") return;
  const itemId = typeof item.id === "string" ? item.id : undefined;
  const encrypted = typeof item.encrypted_content === "string" ? item.encrypted_content : undefined;
  if (itemId === undefined || encrypted === undefined || encrypted.length === 0) return;
  state.artifacts.push({ kind: "openai-reasoning-encrypted-content", association: itemId, value: encrypted });
}

function outputItems(response: Readonly<Record<string, unknown>> | undefined): readonly Readonly<Record<string, unknown>>[] {
  if (response === undefined) return [];
  const output = response.output;
  return Array.isArray(output) ? output.filter((item): item is Readonly<Record<string, unknown>> => Boolean(record(item))) : [];
}

function stopReasonOf(response: Readonly<Record<string, unknown>> | undefined): string {
  const incomplete = record(response?.incomplete_details);
  if (incomplete !== undefined) {
    if (incomplete.reason === "max_output_tokens") return "max_tokens";
    if (incomplete.reason === "content_filter") return "content_filter";
    return "incomplete";
  }
  if (response?.status === "incomplete") return "incomplete";
  return "end_turn";
}

/** Builds the ordered Responses `input` item array, preserving tool/reasoning ordering and #119 artifacts. */
function responsesInput(request: CanonicalRequest): readonly unknown[] {
  const items: unknown[] = [];
  for (const message of request.messages) {
    for (const content of message.content) {
      switch (content.type) {
        case "text":
          items.push({ type: "message", role: message.role, content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: content.text }] });
          break;
        case "image":
          items.push({ type: "message", role: message.role, content: [{ type: "input_image", image_url: `data:${content.mediaType};base64,${content.data}` }] });
          break;
        case "tool-call":
          items.push({ type: "function_call", call_id: content.id, name: content.name, arguments: JSON.stringify(content.input) });
          break;
        case "tool-result":
          items.push({ type: "function_call_output", call_id: content.toolCallId, output: textOf(content.content) });
          break;
        case "reasoning": {
          const item: Record<string, unknown> = { type: "reasoning", ...(content.id === undefined ? {} : { id: content.id }), summary: [{ type: "summary_text", text: content.text }] };
          const encrypted = content.id === undefined ? undefined : artifactValue(request.fidelity, "openai-reasoning-encrypted-content", content.id);
          if (encrypted !== undefined) item.encrypted_content = encrypted;
          items.push(item);
          break;
        }
        case "redacted-reasoning":
          // #119: opaque redacted reasoning cannot be reconstructed; the
          // fail-closed fidelity check already rejected required artifacts.
          break;
      }
    }
  }
  return items;
}

type SseFrame = Readonly<{ error: true }> | Readonly<{ event?: string; data: Readonly<Record<string, unknown>> }>;

async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncIterable<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      const records = buffered.split(/\r?\n\r?\n/);
      buffered = records.pop() ?? "";
      for (const block of records) {
        let event: string | undefined;
        const dataLines: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice("event:".length).trim();
          if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
        }
        const data = dataLines.join("\n");
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as unknown;
          yield { ...(event === undefined ? {} : { event }), data: record(parsed) ?? {} };
        } catch {
          yield { error: true };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
