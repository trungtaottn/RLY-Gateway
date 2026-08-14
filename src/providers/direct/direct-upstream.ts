import type { GatewayConfig } from "../../config/schema.js";
import type { CanonicalEvent } from "../../core/canonical-event.js";
import type { CanonicalRequest } from "../../core/canonical-request.js";
import { decideRoute, type RouteRecord } from "../../core/router.js";
import { conservativeTokenCount } from "../../core/token-counting.js";
import type { CanonicalUpstream } from "../../protocols/anthropic/fake-upstream.js";
import { resolveConfiguredRoute, routesFromConfig } from "../../registry/model-registry.js";
import { providerContract } from "../catalog.js";
import { createProviderAdapter } from "../dispatch.js";

export type ResolvedDirectRoute = Readonly<{ route: RouteRecord; upstream: CanonicalUpstream }>;

/** Resolves only an explicit configured role or exact configured model; never falls back. */
export function createDirectRouteResolver(config: GatewayConfig, configFingerprint: string, environment: NodeJS.ProcessEnv = process.env): (request: CanonicalRequest) => ResolvedDirectRoute | undefined {
  const routes = routesFromConfig(config);
  return (request) => {
    const route = resolveConfiguredRoute(routes, request.requestedModel);
    if (!route) return undefined;
    const role = route.role === "primary" || route.role === "fast" || route.role === "reasoning" ? route.role : undefined;
    const baseUrl = role === undefined ? undefined : config.routes[role]?.baseUrl;
    const contract = providerContract(route.providerId);
    if (!contract || contract.integrationMode !== "direct") return undefined;
    const adapter = createProviderAdapter({
      provider: {
        id: "00000000-0000-4000-8000-000000000000",
        name: route.providerId,
        integrationMode: "direct",
        endpointPolicy: baseUrl ?? contract.defaultEndpoint,
        capabilityEvidence: undefined,
        requiredTermsRevision: undefined,
        provenanceRef: undefined,
        enabled: true,
        version: 1,
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      },
      request: fetch,
      environment,
    });
    const decision = decideRoute({ requestId: request.id, route, required: [], configFingerprint });
    const effectiveRequest: CanonicalRequest = Object.freeze({ ...request, requestedModel: route.modelId, modelRole: route.role === "primary" || route.role === "fast" || route.role === "reasoning" ? route.role : "unknown" });
    return {
      route,
      upstream: {
        invoke: (_ignored: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent> => adapter.invoke(effectiveRequest, decision, signal),
        countTokens: () => Promise.resolve(conservativeTokenCount(effectiveRequest)),
      },
    };
  };
}
