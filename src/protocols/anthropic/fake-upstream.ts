import type { TokenCountingQuality } from "../../core/capabilities.js";
import type { CanonicalEvent } from "../../core/canonical-event.js";
import type { CanonicalRequest } from "../../core/canonical-request.js";
import { ProviderAdapterError } from "../../providers/provider-adapter.js";

export type FakeUpstreamScenario = "text" | "tool" | "slow" | "malformed" | "disconnect" | "auth" | "rate-limit" | "server-error";
export type CanonicalUpstream = Readonly<{ invoke: (request: CanonicalRequest, signal: AbortSignal) => AsyncIterable<CanonicalEvent>; countTokens?: (request: CanonicalRequest) => Promise<{ inputTokens: number; quality: TokenCountingQuality }> }>;

function event(request: CanonicalRequest, sequence: number, type: CanonicalEvent["type"], data: object): CanonicalEvent {
  return { requestId: request.id, sequence, timestamp: "2026-08-13T00:00:00.000Z", providerId: "fake", modelId: request.requestedModel, type, ...data } as CanonicalEvent;
}

export class FakeCanonicalUpstream implements CanonicalUpstream {
  constructor(private readonly scenario: FakeUpstreamScenario = "text") {}
  async *invoke(request: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
    if (this.scenario === "auth" || this.scenario === "rate-limit" || this.scenario === "server-error") {
      const code = this.scenario === "auth" ? "authentication_error" : this.scenario === "rate-limit" ? "rate_limit_error" : "api_error";
      yield event(request, 0, "response-failed", { code, message: "synthetic upstream failure" }); return;
    }
    yield event(request, 0, "response-started", { responseId: "msg_fake" });
    if (this.scenario === "disconnect") throw new Error("synthetic disconnect before first byte");
    if (this.scenario === "malformed") { yield event(request, 1, "content-completed", { index: 0 }); return; }
    if (this.scenario === "slow") await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 15); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")); }, { once: true }); });
    if (signal.aborted) throw signal.reason;
    if (this.scenario === "tool") {
      yield event(request, 1, "content-started", { index: 0, contentType: "tool-call", toolCallId: "fixture-tool", toolName: "fixture_tool" });
      yield event(request, 2, "tool-arguments-delta", { index: 0, toolCallId: "tool_0", partialJson: "{\"unit\":\"fixture\"}" });
    } else {
      yield event(request, 1, "content-started", { index: 0, contentType: "text" });
      yield event(request, 2, "text-delta", { index: 0, text: "synthetic response" });
    }
    yield event(request, 3, "content-completed", { index: 0 });
    yield event(request, 4, "usage-updated", { inputTokens: 12, outputTokens: 4 });
    yield event(request, 5, "response-completed", { stopReason: this.scenario === "tool" ? "tool_use" : "end_turn" });
  }
  countTokens(): Promise<{ inputTokens: number; quality: "exact-local" }> { return Promise.resolve({ inputTokens: 12, quality: "exact-local" }); }
}

export class RetryableTransportError extends Error {
  /** #121: retry only when the failure proves the request never crossed a commitment boundary. */
  public readonly commitment = "not-sent" as const;
  constructor(message = "transport failed before first byte") { super(message); this.name = "RetryableTransportError"; }
}

/**
 * A retry can occur only when the previous attempt provably did not cross a
 * provider/client/tool commitment boundary. #121: `collectWithSafeRetry` now
 * consumes the failure's commitment state — `RetryableTransportError`
 * (failed before send) is retried once; an ambiguous/unknown outcome after a
 * network failure is never replayed.
 */
export async function collectWithSafeRetry(upstream: CanonicalUpstream, request: CanonicalRequest, signal: AbortSignal): Promise<CanonicalEvent[]> {
  let emitted = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const events: CanonicalEvent[] = [];
      for await (const item of upstream.invoke(request, signal)) { emitted = true; events.push(item); }
      return events;
    } catch (error) {
      const commitment = error instanceof RetryableTransportError ? error.commitment : error instanceof ProviderAdapterError ? error.commitment : "unknown";
      if (emitted || attempt === 1 || signal.aborted || commitment !== "not-sent" || !(error instanceof RetryableTransportError)) throw error;
    }
  }
  return [];
}
