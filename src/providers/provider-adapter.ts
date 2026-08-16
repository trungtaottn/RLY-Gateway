import type { ProviderCapabilities, TokenCountingQuality } from "../core/capabilities.js";
import type { CanonicalEvent } from "../core/canonical-event.js";
import type { CanonicalRequest } from "../core/canonical-request.js";
import type { RouteDecision } from "../core/route-decision.js";
import type { CommitmentState } from "./commitment.js";
import type { ProviderErrorInfo } from "./provider-error.js";

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

/**
 * Provider failure crossing the adapter boundary (#121).
 *
 * `info` carries safe structured provider error metadata (status/code/type/
 * retry-after/rate-limit and protocol-required body fields) so clients and
 * error policies never rely on generic normalization alone. `commitment`
 * records the execution commitment state at the moment of failure so
 * routing/retry can prove whether the attempt crossed a commitment boundary.
 */
export class ProviderAdapterError extends Error {
  constructor(
    public readonly code: string,
    message = "Provider request failed",
    public readonly info?: ProviderErrorInfo,
    public readonly commitment: CommitmentState = "unknown",
  ) {
    super(message);
    this.name = "ProviderAdapterError";
  }
}
