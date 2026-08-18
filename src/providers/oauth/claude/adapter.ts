import type { CanonicalEvent } from "../../../core/canonical-event.js";
import type { CanonicalRequest } from "../../../core/canonical-request.js";
import type { RouteDecision } from "../../../core/route-decision.js";
import type { SecretHandle } from "../../../credentials/env-resolver.js";
import { ProviderAdapterError, type ProviderAdapter, type ProviderProbe } from "../../provider-adapter.js";

export const CLAUDE_OAUTH_ADAPTER_ID = "claude-oauth";
export const CLAUDE_OAUTH_ENDPOINT = "https://api.anthropic.com";

export class ClaudeOAuthAdapter implements ProviderAdapter {
  readonly id = CLAUDE_OAUTH_ADAPTER_ID;

  public constructor(
    private readonly request: typeof fetch,
    private readonly accessToken: SecretHandle,
    private readonly endpoint = CLAUDE_OAUTH_ENDPOINT,
  ) {}

  public async probe(decision: RouteDecision, signal: AbortSignal): Promise<ProviderProbe> {
    const response = await this.request(`${this.endpoint.replace(/\/$/, "")}/v1/models`, {
      method: "GET",
      signal,
      headers: this.headers(),
    });
    return {
      providerId: decision.providerId,
      modelId: decision.modelId,
      readiness: probeReadiness(response),
      checkedAt: new Date().toISOString(),
    };
  }

  public async *invoke(request: CanonicalRequest, decision: RouteDecision, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
    if (request.stream || request.tools.length > 0) {
      throw new ProviderAdapterError("unavailable", "claude oauth adapter does not support streaming or tools");
    }
    const response = await this.request(`${this.endpoint.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      signal,
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(toAnthropicPayload(request)),
    });
    if (!response.ok) {
      throw new ProviderAdapterError(invokeErrorCode(response.status));
    }
    const body = await response.json() as {
      id?: string;
      content?: readonly { type?: string; text?: string }[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (body.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("");
    let sequence = 0;
    const event = (type: CanonicalEvent["type"], data: object): CanonicalEvent => ({
      requestId: request.id, sequence: sequence++, timestamp: new Date().toISOString(),
      providerId: decision.providerId, modelId: decision.modelId, type, ...data,
    } as CanonicalEvent);
    yield event("response-started", { responseId: body.id ?? "claude-response" });
    if (text) {
      yield event("content-started", { index: 0, contentType: "text" });
      yield event("text-delta", { index: 0, text });
      yield event("content-completed", { index: 0 });
    }
    yield event("usage-updated", { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 });
    yield event("response-completed", { stopReason: body.stop_reason === "tool_use" ? "tool_use" : "end_turn" });
  }

  private headers(): Readonly<Record<string, string>> {
    return { authorization: `Bearer ${this.accessToken.reveal()}`, "anthropic-version": "2023-06-01" };
  }
}

function probeReadiness(response: Response): ProviderProbe["readiness"] {
  if (response.status === 401 || response.status === 403) return "unauthenticated";
  return response.ok ? "ready" : "unavailable";
}

function invokeErrorCode(status: number): "authentication_error" | "rate_limit_error" | "api_error" {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  return "api_error";
}

function toAnthropicPayload(request: CanonicalRequest): Record<string, unknown> {
  return {
    model: request.requestedModel,
    max_tokens: request.inference.maxOutputTokens ?? 1024,
    messages: request.messages.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content.filter((item) => item.type === "text").map((item) => ("text" in item ? item.text : "")).join("\n"),
    })),
    ...(request.system.length ? { system: request.system.filter((item) => item.type === "text").map((item) => item.text).join("\n") } : {}),
  };
}
