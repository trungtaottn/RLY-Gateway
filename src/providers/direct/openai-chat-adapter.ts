import { resolveEnvironmentCredential, type SecretHandle } from "../../credentials/env-resolver.js";
import type { CanonicalContent, CanonicalMessage, CanonicalRequest } from "../../core/canonical-request.js";
import type { CanonicalEvent } from "../../core/canonical-event.js";
import { unsupportedRequiredArtifacts } from "../../core/fidelity.js";
import type { ResolvedReasoning } from "../../core/reasoning.js";
import type { RouteDecision } from "../../core/route-decision.js";
import { ProviderAdapterError, type ProviderAdapter, type ProviderProbe } from "../provider-adapter.js";

type Fetch = typeof fetch;
type ChatMessage = Record<string, unknown>;
type ChatCompletion = Readonly<{ id?: string; model?: string; choices?: readonly { message?: Record<string, unknown>; finish_reason?: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }>;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;

function textOf(content: readonly CanonicalContent[]): string {
  return content.filter((item): item is Extract<CanonicalContent, { type: "text" }> | Extract<CanonicalContent, { type: "reasoning" }> => item.type === "text" || item.type === "reasoning").map((item) => item.text).join("\n");
}

function contentValue(content: readonly CanonicalContent[]): string | readonly Record<string, unknown>[] {
  const hasImage = content.some((item) => item.type === "image");
  if (!hasImage) return textOf(content);
  return content.flatMap((item): Record<string, unknown>[] => {
    if (item.type === "text") return [{ type: "text", text: item.text }];
    if (item.type === "image") return [{ type: "image_url", image_url: { url: `data:${item.mediaType};base64,${item.data}` } }];
    return [];
  });
}

function toChatMessages(messages: readonly CanonicalMessage[], includeReasoningReplay: boolean): ChatMessage[] {
  return messages.flatMap((message) => {
    const toolResults = message.content.filter((item): item is Extract<CanonicalContent, { type: "tool-result" }> => item.type === "tool-result");
    if (toolResults.length > 0) return toolResults.map((item) => ({ role: "tool", tool_call_id: item.toolCallId, content: textOf(item.content) }));
    const toolCalls = message.content.filter((item): item is Extract<CanonicalContent, { type: "tool-call" }> => item.type === "tool-call");
    const reasoning = message.content.filter((item): item is Extract<CanonicalContent, { type: "reasoning" }> => item.type === "reasoning").map((item) => item.text).join("\n");
    const result: ChatMessage = { role: message.role, content: contentValue(message.content) };
    if (toolCalls.length > 0) result.tool_calls = toolCalls.map((item) => ({ id: item.id, type: "function", function: { name: item.name, arguments: JSON.stringify(item.input) } }));
    if (includeReasoningReplay && reasoning && toolCalls.length > 0) result.reasoning_content = reasoning;
    return [result];
  });
}

function parseError(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  return "api_error";
}

function event(request: CanonicalRequest, decision: RouteDecision, sequence: number, type: CanonicalEvent["type"], data: object): CanonicalEvent {
  return { requestId: request.id, sequence, timestamp: new Date().toISOString(), providerId: decision.providerId, modelId: decision.modelId, type, ...data } as CanonicalEvent;
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
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
      for (const record of records) {
        const data = record.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Shared transport only; provider-specific adapters own their endpoint and codec choices. */
export abstract class OpenAiChatAdapter implements ProviderAdapter {
  abstract readonly id: string;
  protected abstract readonly endpoint: string;
  protected readonly replayReasoningContent: boolean = false;
  constructor(private readonly request: Fetch = fetch, endpoint?: string, private readonly environment: NodeJS.ProcessEnv = process.env, private readonly timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS) {
    if (endpoint !== undefined) this.endpointOverride = endpoint.replace(/\/$/, "");
  }
  private readonly endpointOverride: string | undefined;
  protected get requestEndpoint(): string { return this.endpointOverride ?? this.endpoint; }

  protected payload(request: CanonicalRequest, reasoning?: ResolvedReasoning): Record<string, unknown> {
    return {
      model: request.requestedModel,
      messages: [
        ...(request.system.length ? [{ role: "system", content: contentValue(request.system) }] : []),
        ...toChatMessages(request.messages, this.replayReasoningContent),
      ],
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), parameters: tool.inputSchema } })) } : {}),
      ...(request.toolChoice === undefined ? {} : { tool_choice: request.toolChoice.type === "tool" ? { type: "function", function: { name: request.toolChoice.name } } : request.toolChoice.type }),
      stream: request.stream,
      ...(request.stream ? { stream_options: { include_usage: true } } : {}),
      ...(request.inference.maxOutputTokens === undefined ? {} : { max_tokens: request.inference.maxOutputTokens }),
      ...(request.inference.temperature === undefined ? {} : { temperature: request.inference.temperature }),
      ...(request.inference.topP === undefined ? {} : { top_p: request.inference.topP }),
      ...(request.inference.stopSequences === undefined ? {} : { stop: request.inference.stopSequences }),
      ...this.reasoningPayload(reasoning),
    };
  }

  /**
   * #70: emits the provider-native reasoning parameter from the deterministic
   * translation result. The adapter owns the exact wire shape; the translation
   * boundary (`resolveReasoning`) owns the semantic mapping. Never collapses
   * enabled/adaptive/effort/budget into one boolean.
   */
  protected reasoningPayload(resolved: ResolvedReasoning | undefined): Record<string, unknown> {
    if (resolved === undefined) return {};
    switch (resolved.effective.kind) {
      case "off":
        return { reasoning: { enabled: false } };
      case "provider-default":
        return {};
      case "binary":
        return { reasoning: { enabled: resolved.effective.enabled } };
      case "effort":
        return { reasoning: { enabled: true, effort: resolved.effective.level } };
      case "adaptive":
        return { reasoning: { enabled: true } };
      case "budget":
        return { reasoning: { enabled: true, max_tokens: resolved.effective.budgetTokens } };
    }
  }

  protected ownsSecret = true;
  protected resolveSecret(decision: RouteDecision): SecretHandle {
    return resolveEnvironmentCredential(decision.credentialRef, this.environment);
  }
  protected extraHeaders(): Readonly<Record<string, string>> {
    return {};
  }

  private async post(request: CanonicalRequest, decision: RouteDecision, signal: AbortSignal): Promise<Response> {
    const secret = this.resolveSecret(decision);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.request(`${this.requestEndpoint}/chat/completions`, { method: "POST", signal: AbortSignal.any([signal, timeout]), headers: { authorization: `Bearer ${secret.reveal()}`, "content-type": "application/json", accept: request.stream ? "text/event-stream" : "application/json", ...this.extraHeaders() }, body: JSON.stringify(this.payload(request, decision.resolvedReasoning)) });
      if (!response.ok) throw new ProviderAdapterError(parseError(response.status));
      return response;
    } catch (error) {
      if (timeout.aborted && !signal.aborted) throw new ProviderAdapterError("api_error", "Provider request timed out");
      throw error;
    } finally {
      if (this.ownsSecret) secret.dispose();
    }
  }

  async *invoke(request: CanonicalRequest, decision: RouteDecision, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
    // #119 fail-closed fidelity: Chat Completions transport cannot represent
    // opaque continuation artifacts (signatures, encrypted reasoning content).
    // A required artifact on this cross-protocol path is unsupported, never
    // fabricated and never silently dropped.
    const unsupported = unsupportedRequiredArtifacts(request.fidelity, []);
    if (unsupported.length > 0) {
      throw new ProviderAdapterError("unsupported-fidelity", `Chat Completions cannot preserve required continuation artifact: ${unsupported.join(", ")}`);
    }
    const response = await this.post(request, decision, signal);
    let sequence = 0;
    if (!request.stream) {
      const data = await response.json() as ChatCompletion;
      const choice = data.choices?.[0];
      yield event(request, decision, sequence++, "response-started", { responseId: data.id ?? "provider-response" });
      const message = choice?.message ?? {};
      const text = typeof message.content === "string" ? message.content : "";
      if (text) { yield event(request, decision, sequence++, "content-started", { index: 0, contentType: "text" }); yield event(request, decision, sequence++, "text-delta", { index: 0, text }); yield event(request, decision, sequence++, "content-completed", { index: 0 }); }
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const [index, call] of calls.entries()) {
        const functionCall = call && typeof call === "object" ? (call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }).function : undefined;
        const callId = call && typeof call === "object" && typeof (call as { id?: unknown }).id === "string" ? (call as { id: string }).id : `tool-${String(index)}`;
        const name = typeof functionCall?.name === "string" ? functionCall.name : "tool";
        const argumentsText = typeof functionCall?.arguments === "string" ? functionCall.arguments : "{}";
        yield event(request, decision, sequence++, "content-started", { index: index + 1, contentType: "tool-call", toolCallId: callId, toolName: name });
        yield event(request, decision, sequence++, "tool-arguments-delta", { index: index + 1, toolCallId: callId, partialJson: argumentsText });
        yield event(request, decision, sequence++, "content-completed", { index: index + 1 });
      }
      if (data.usage) yield event(request, decision, sequence++, "usage-updated", { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens });
      yield event(request, decision, sequence, "response-completed", { stopReason: choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn" });
      return;
    }
    if (!response.body) throw new ProviderAdapterError("api_error");
    let started = false;
    const open = new Set<number>();
    const toolIds = new Map<number, string>();
    const pendingToolArguments = new Map<number, string[]>();
    let completed = false;
    for await (const raw of sseData(response.body)) {
      if (raw === "[DONE]") break;
      let chunk: { id?: string; choices?: { delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown }; finish_reason?: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { code?: unknown } };
      try { chunk = JSON.parse(raw) as typeof chunk; } catch { continue; }
      if (chunk.error) throw new ProviderAdapterError(typeof chunk.error.code === "string" ? chunk.error.code : "api_error");
      if (!started) { yield event(request, decision, sequence++, "response-started", { responseId: chunk.id ?? "provider-response" }); started = true; }
      const choice = chunk.choices?.[0]; const delta = choice?.delta;
      if (typeof delta?.content === "string" && delta.content) { if (!open.has(0)) { open.add(0); yield event(request, decision, sequence++, "content-started", { index: 0, contentType: "text" }); } yield event(request, decision, sequence++, "text-delta", { index: 0, text: delta.content }); }
      if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) { const index = 1000; if (!open.has(index)) { open.add(index); yield event(request, decision, sequence++, "content-started", { index, contentType: "reasoning" }); } yield event(request, decision, sequence++, "reasoning-delta", { index, text: delta.reasoning_content }); }
      if (Array.isArray(delta?.tool_calls)) for (const rawCall of delta.tool_calls) {
        if (!rawCall || typeof rawCall !== "object") continue;
        const call = rawCall as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
        const index = typeof call.index === "number" ? call.index + 1 : 1;
        const id = typeof call.id === "string" ? call.id : toolIds.get(index) ?? `tool-${String(index)}`;
        toolIds.set(index, id);
        if (!open.has(index) && typeof call.function?.name === "string") {
          open.add(index);
          yield event(request, decision, sequence++, "content-started", { index, contentType: "tool-call", toolCallId: id, toolName: call.function.name });
          for (const argumentsFragment of pendingToolArguments.get(index) ?? []) yield event(request, decision, sequence++, "tool-arguments-delta", { index, toolCallId: id, partialJson: argumentsFragment });
          pendingToolArguments.delete(index);
        }
        if (typeof call.function?.arguments === "string" && call.function.arguments) {
          if (open.has(index)) yield event(request, decision, sequence++, "tool-arguments-delta", { index, toolCallId: id, partialJson: call.function.arguments });
          else pendingToolArguments.set(index, [...(pendingToolArguments.get(index) ?? []), call.function.arguments]);
        }
      }
      if (chunk.usage) yield event(request, decision, sequence++, "usage-updated", { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens });
      if (choice?.finish_reason) {
        if (pendingToolArguments.size > 0) throw new ProviderAdapterError("api_error", "Provider ended a tool stream before declaring its function name");
        for (const index of open) yield event(request, decision, sequence++, "content-completed", { index });
        open.clear();
        yield event(request, decision, sequence++, "response-completed", { stopReason: choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn" });
        completed = true;
      }
    }
    if (!started) throw new ProviderAdapterError("api_error");
    if (!completed) throw new ProviderAdapterError("api_error");
  }

  async probe(decision: RouteDecision, signal: AbortSignal): Promise<ProviderProbe> {
    const secret = this.resolveSecret(decision);
    try {
      const response = await this.request(`${this.requestEndpoint}/models`, { signal, headers: { authorization: `Bearer ${secret.reveal()}`, ...this.extraHeaders() } });
      if (!response.ok) return { providerId: decision.providerId, modelId: decision.modelId, readiness: response.status === 401 || response.status === 403 ? "unauthenticated" : "unavailable", checkedAt: new Date().toISOString() };
      const catalog = await response.json() as { data?: unknown };
      const exists = Array.isArray(catalog.data) && catalog.data.some((item) => Boolean(item) && typeof item === "object" && (item as { id?: unknown }).id === decision.modelId);
      return { providerId: decision.providerId, modelId: decision.modelId, readiness: exists ? "ready" : "unavailable", ...(exists ? { capabilities: decision.capabilitySnapshot } : {}), checkedAt: new Date().toISOString() };
    } finally { if (this.ownsSecret) secret.dispose(); }
  }
}
