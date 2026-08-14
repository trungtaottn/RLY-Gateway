import type { ProviderCapabilities } from "../core/capabilities.js";
import type { RouteDecision } from "../core/route-decision.js";
import { createRouteDecision } from "../core/route-decision.js";
import type { RouteRecord } from "../core/router.js";

export type EffectiveRoute = Readonly<{
  requestId: string;
  providerId: string;
  modelId: string;
  adapterId: string;
  accountId: string;
  accountPseudonym: string;
  credentialHandle: string;
  credentialGeneration: number;
  sourceRule: string;
  policyRevision: number;
  policyHash: string;
  capabilitySnapshot: ProviderCapabilities;
  decidedAt: string;
  outputStarted: boolean;
}>;

export function createEffectiveRoute(route: EffectiveRoute): EffectiveRoute {
  return Object.freeze({
    ...route,
    capabilitySnapshot: Object.freeze({ ...route.capabilitySnapshot }),
  });
}

export function markOutputStarted(route: EffectiveRoute): EffectiveRoute {
  return createEffectiveRoute({ ...route, outputStarted: true });
}

export function toRouteRecord(route: EffectiveRoute, role: string): RouteRecord {
  return {
    role,
    providerId: route.providerId,
    modelId: route.modelId,
    adapterId: route.adapterId,
    credentialRef: { kind: "handle", handle: route.credentialHandle },
    capabilities: route.capabilitySnapshot,
  };
}

export function toRouteDecision(route: EffectiveRoute, configFingerprint: string): RouteDecision {
  return createRouteDecision({
    requestId: route.requestId,
    providerId: route.providerId,
    modelId: route.modelId,
    adapterId: route.adapterId,
    credentialRef: { kind: "handle", handle: route.credentialHandle },
    sourceRule: route.sourceRule,
    configFingerprint,
    capabilitySnapshot: route.capabilitySnapshot,
    decidedAt: route.decidedAt,
    accountPseudonym: route.accountPseudonym,
    credentialGeneration: route.credentialGeneration,
  });
}
