import type { ProviderCapabilities, TokenCountingQuality } from "../core/capabilities.js";
import type { CanonicalEvent } from "../core/canonical-event.js";
import type { CanonicalRequest } from "../core/canonical-request.js";
import type { RouteDecision } from "../core/route-decision.js";

export type ProviderReadiness = "ready" | "unavailable" | "unauthenticated";

export type ProviderProbe = Readonly<{
  providerId: string;
  modelId: string;
  readiness: ProviderReadiness;
  capabilities?: ProviderCapabilities;
  checkedAt: string;
}>;

/** Direct providers receive only a request-scoped, immutable route decision. */
export interface ProviderAdapter {
  readonly id: string;
  invoke(request: CanonicalRequest, decision: RouteDecision, signal: AbortSignal): AsyncIterable<CanonicalEvent>;
  probe(decision: RouteDecision, signal: AbortSignal): Promise<ProviderProbe>;
  countTokens?(request: CanonicalRequest, decision: RouteDecision, signal: AbortSignal): Promise<{ inputTokens: number; quality: TokenCountingQuality }>;
}

export class ProviderAdapterError extends Error {
  constructor(public readonly code: string, message = "Provider request failed") {
    super(message);
    this.name = "ProviderAdapterError";
  }
}
