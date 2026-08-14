import type { CanonicalEvent } from "../core/canonical-event.js";
import type { CanonicalRequest } from "../core/canonical-request.js";
import type { CapabilityRequirement, ProviderCapabilities } from "../core/capabilities.js";
import { decideRoute, type RouteRecord } from "../core/router.js";
import { conservativeTokenCount } from "../core/token-counting.js";
import type { ControlPlaneStore } from "../control-plane/store.js";
import type { AccountRecord, ProviderRecord } from "../control-plane/types.js";
import type { CredentialBroker } from "../credentials/broker.js";
import { parseCredentialRef } from "../credentials/credential-ref.js";
import type { CanonicalUpstream } from "../protocols/anthropic/fake-upstream.js";
import { DeepSeekAdapter } from "../providers/direct/deepseek-adapter.js";
import { OpenRouterAdapter } from "../providers/direct/openrouter-adapter.js";
import { CodexOAuthAdapter, CODEX_OAUTH_ADAPTER_ID } from "../providers/oauth/codex/adapter.js";
import { directProviderRegistry, findModelEvidence } from "../registry/model-registry.js";
import { toRouteDecision, type EffectiveRoute } from "../routing/effective-route.js";
import type { CredentialSnapshot } from "../routing/eligibility/reasons.js";
import { streamPoolRequest } from "../routing/pools/execute.js";
import type { RouteSelector } from "../routing/pools/selector.js";
import { activateProfile } from "./activate.js";
import { ProfileActivationError } from "./errors.js";
import { applyCapabilityPolicy, parseCapabilityPolicy } from "./schema.js";
import type { LaunchSession } from "./sessions.js";
import type { RouteTraceRing } from "./traces.js";

const DEFAULT_CAPABILITIES: ProviderCapabilities = Object.freeze({
  streaming: true,
  tools: true,
  parallelTools: false,
  images: false,
  reasoning: true,
  redactedReasoning: false,
  structuredOutput: false,
  tokenCounting: "conservative-estimate",
});

export type ProfileRouteDependencies = Readonly<{
  store: ControlPlaneStore;
  broker: CredentialBroker;
  selector: RouteSelector;
  traces: RouteTraceRing;
  configFingerprint: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  required?: readonly CapabilityRequirement[];
}>;

export type ResolvedProfileRoute = Readonly<{ route: RouteRecord; upstream: CanonicalUpstream }>;

export async function resolveProfileRoute(
  canonical: CanonicalRequest,
  session: LaunchSession,
  dependencies: ProfileRouteDependencies,
): Promise<ResolvedProfileRoute> {
  const policy = dependencies.store.currentPolicy();
  if (!policy) throw new ProfileActivationError("profile-not-found");
  const activated = activateProfile(policy.snapshot.profiles, {
    profileId: session.profileId,
    name: session.profileName,
    requestedModel: canonical.requestedModel,
    required: dependencies.required ?? [],
    baseCapabilities: DEFAULT_CAPABILITIES,
  });
  const pool = policy.snapshot.pools.find((item) => item.id === activated.poolId);
  if (!pool) throw new ProfileActivationError("profile-has-no-pool");
  const provider = policy.snapshot.providers.find((item) => item.id === pool.providerId);
  if (!provider) throw new ProfileActivationError("profile-has-no-pool");
  const modelEvidence = findModelEvidence(directProviderRegistry, provider.name, activated.modelId);
  const capabilities = applyCapabilityPolicy(
    modelEvidence?.capabilities ?? DEFAULT_CAPABILITIES,
    parseCapabilityPolicy(activated.profile.capabilityPolicy),
  );
  const adapterId = adapterIdFor(provider);
  const route: RouteRecord = {
    role: activated.role,
    providerId: provider.name,
    modelId: activated.modelId,
    adapterId,
    credentialRef: { kind: "handle", handle: "cred-profile-policy" },
    capabilities,
  };
  decideRoute({
    requestId: canonical.id,
    route,
    required: dependencies.required ?? [],
    configFingerprint: dependencies.configFingerprint,
  });
  const environment = dependencies.environment ?? process.env;
  const members = policy.snapshot.accounts.filter((account) => pool.memberships.some((item) => item.accountId === account.id));
  const snapshots = await credentialSnapshots(dependencies, members, environment);
  const effectiveRequest: CanonicalRequest = Object.freeze({
    ...canonical,
    requestedModel: activated.modelId,
    modelRole: activated.role,
  });
  return {
    route,
    upstream: {
      invoke: (_ignored: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent> => {
        return streamPoolRequest({
          selector: dependencies.selector,
          store: dependencies.store,
          request: effectiveRequest,
          select: {
            poolId: activated.poolId,
            policy,
            required: dependencies.required ?? [],
            capabilities,
            modelId: activated.modelId,
            adapterId,
            role: activated.role,
            credentialSnapshots: snapshots,
            sessionKey: session.leaseId,
          },
          invoke: (selected, invokeSignal) => invokeSelected(
            effectiveRequest,
            selected,
            provider,
            dependencies,
            environment,
            invokeSignal,
          ),
          signal,
          onTrace: (trace) => dependencies.traces.push(trace, session.profileName),
        });
      },
      countTokens: () => Promise.resolve(conservativeTokenCount(effectiveRequest)),
    },
  };
}

function adapterIdFor(provider: ProviderRecord): string {
  if (provider.integrationMode === "oauth") return CODEX_OAUTH_ADAPTER_ID;
  if (provider.name === "deepseek") return "deepseek-direct";
  return "openrouter-direct";
}

function envCredentialName(handle: string): string | undefined {
  return handle.startsWith("env:") ? handle.slice(4) : undefined;
}

async function credentialSnapshots(
  dependencies: ProfileRouteDependencies,
  accounts: readonly AccountRecord[],
  environment: NodeJS.ProcessEnv,
): Promise<ReadonlyMap<string, CredentialSnapshot>> {
  const entries: [string, CredentialSnapshot][] = [];
  for (const account of accounts) {
    const envName = envCredentialName(account.credentialHandle);
    if (envName !== undefined) {
      entries.push([account.credentialHandle, {
        present: Boolean(environment[envName]),
        generation: Math.max(account.credentialGeneration, 1),
      }]);
      continue;
    }
    try {
      const metadata = await dependencies.broker.metadata(account.credentialHandle);
      entries.push([account.credentialHandle, {
        present: metadata !== undefined && metadata.generation >= 1,
        generation: metadata?.generation ?? 0,
        ...(metadata?.expiresAt === undefined ? {} : { expiresAt: metadata.expiresAt }),
      }]);
    } catch {
      entries.push([account.credentialHandle, { present: false, generation: 0 }]);
    }
  }
  return new Map(entries);
}

async function* invokeSelected(
  request: CanonicalRequest,
  route: EffectiveRoute,
  provider: ProviderRecord,
  dependencies: ProfileRouteDependencies,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): AsyncIterable<CanonicalEvent> {
  const decision = toRouteDecision(route, dependencies.configFingerprint);
  const endpoint = provider.endpointPolicy;
  if (provider.integrationMode === "oauth") {
    const scoped = await dependencies.broker.resolve(route.credentialHandle);
    try {
      const adapter = new CodexOAuthAdapter(dependencies.fetch ?? fetch, scoped.accessToken, endpoint, scoped.accountId);
      yield* adapter.invoke(request, decision, signal);
    } finally {
      scoped.dispose();
    }
    return;
  }
  const envName = envCredentialName(route.credentialHandle);
  const envDecision = envName === undefined
    ? decision
    : { ...decision, credentialRef: parseCredentialRef(`env:${envName}`) };
  const adapter = provider.name === "deepseek"
    ? new DeepSeekAdapter(dependencies.fetch ?? fetch, endpoint, environment)
    : new OpenRouterAdapter(dependencies.fetch ?? fetch, endpoint, environment);
  yield* adapter.invoke(request, envDecision, signal);
}
