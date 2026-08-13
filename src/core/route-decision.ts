import type { ProviderCapabilities } from "./capabilities.js";
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
}>;

export function createRouteDecision(decision: RouteDecision): RouteDecision {
  return Object.freeze({
    ...decision,
    credentialRef: Object.freeze({ ...decision.credentialRef }),
    capabilitySnapshot: Object.freeze({ ...decision.capabilitySnapshot }),
  });
}

