import type { ReasoningCapabilityEvidence } from "./capabilities.js";
import type { ProviderCapabilities } from "./capabilities.js";
import type { ResolvedReasoning } from "./reasoning.js";
import type { CredentialRef } from "../credentials/credential-ref.js";

export type RouteDecision = Readonly<{
  requestId: string;
  providerId: string;
  modelId: string;
  adapterId: string;
  credentialRef: CredentialRef;
  sourceRule: string;
  configFingerprint: string;
  capabilitySnapshot: ProviderCapabilities;
  decidedAt: string;
  accountPseudonym?: string;
  credentialGeneration?: number;
  /** Exact selected-model reasoning evidence (#70); adapters translate from it. */
  reasoningEvidence?: ReasoningCapabilityEvidence;
  /** Deterministic intent→native translation result (#70); secret-free metadata. */
  resolvedReasoning?: ResolvedReasoning;
}>;

export function createRouteDecision(decision: RouteDecision): RouteDecision {
  return Object.freeze({
    ...decision,
    credentialRef: Object.freeze({ ...decision.credentialRef }),
    capabilitySnapshot: Object.freeze({ ...decision.capabilitySnapshot }),
  });
}

