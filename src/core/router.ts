import { missingCapabilities, type CapabilityRequirement, type ProviderCapabilities } from "./capabilities.js";
import { createRouteDecision, type RouteDecision } from "./route-decision.js";
import type { CredentialRef } from "../credentials/credential-ref.js";

export type RouteRecord = Readonly<{
  role: string;
  providerId: string;
  modelId: string;
  adapterId: string;
  credentialRef: CredentialRef;
  capabilities: ProviderCapabilities;
}>;

export class UnsupportedRouteError extends Error {
  constructor(public readonly missing: readonly CapabilityRequirement[]) {
    super(`Route does not support required capabilities: ${missing.join(", ")}`);
    this.name = "UnsupportedRouteError";
  }
}

export function decideRoute(input: {
  requestId: string;
  route: RouteRecord;
  required: readonly CapabilityRequirement[];
  configFingerprint: string;
  now?: Date;
  accountPseudonym?: string;
  credentialGeneration?: number;
}): RouteDecision {
  const missing = missingCapabilities(input.route.capabilities, input.required);
  if (missing.length > 0) throw new UnsupportedRouteError(missing);

  return createRouteDecision({
    requestId: input.requestId,
    providerId: input.route.providerId,
    modelId: input.route.modelId,
    adapterId: input.route.adapterId,
    credentialRef: input.route.credentialRef,
    sourceRule: `role:${input.route.role}`,
    configFingerprint: input.configFingerprint,
    capabilitySnapshot: input.route.capabilities,
    decidedAt: (input.now ?? new Date()).toISOString(),
    ...(input.accountPseudonym === undefined ? {} : { accountPseudonym: input.accountPseudonym }),
    ...(input.credentialGeneration === undefined ? {} : { credentialGeneration: input.credentialGeneration }),
  });
}

