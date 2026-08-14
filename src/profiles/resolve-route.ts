import type { CanonicalEvent } from "../core/canonical-event.js";
import type { CanonicalRequest } from "../core/canonical-request.js";
import type { CapabilityRequirement } from "../core/capabilities.js";
import { reasoningRequestFromWire } from "../core/reasoning.js";
import { decideRoute, type RouteRecord } from "../core/router.js";
import { conservativeTokenCount } from "../core/token-counting.js";
import type { ControlPlaneStore } from "../control-plane/store.js";
import type { AccountRecord, ProviderRecord } from "../control-plane/types.js";
import type { CredentialBroker } from "../credentials/broker.js";
import { parseCredentialRef } from "../credentials/credential-ref.js";
import type { CanonicalUpstream } from "../protocols/anthropic/fake-upstream.js";
import { adapterIdFor, createProviderAdapter } from "../providers/dispatch.js";
import { ReasoningTranslationError, resolveReasoning } from "../providers/reasoning.js";
import { toRouteDecision, type EffectiveRoute } from "../routing/effective-route.js";
import type { CredentialSnapshot } from "../routing/eligibility/reasons.js";
import { isModelSelectionError } from "../routing/model-selection/errors.js";
import { selectModel } from "../routing/model-selection/selector.js";
import type { ModelSelectionResult, ReasoningRequirement } from "../routing/model-selection/types.js";
import { streamPoolRequest } from "../routing/pools/execute.js";
import type { RouteSelector } from "../routing/pools/selector.js";
import { activateProfile, findProfileById, inspectLaunchableProfile } from "./activate.js";
import { ProfileActivationError } from "./errors.js";
import { resolveProfileRole } from "./helper-map.js";
import type { LaunchSession } from "./sessions.js";
import type { RouteTraceRing } from "./traces.js";

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
  const named = findProfileById(policy.snapshot.profiles, session.profileId)?.name ?? session.profileName;
  const inspected = inspectLaunchableProfile(policy.snapshot.profiles, named);
  const mapped = resolveProfileRole(canonical.requestedModel, inspected.profile.modelRoles);
  if (!mapped) throw new ProfileActivationError("role-unmapped");
  const pool = policy.snapshot.pools.find((item) => item.id === inspected.poolId);
  if (!pool) throw new ProfileActivationError("profile-has-no-pool");
  const provider = policy.snapshot.providers.find((item) => item.id === pool.providerId);
  if (!provider) throw new ProfileActivationError("profile-has-no-pool");
  // Stage 1: deterministic model capability selection (#68) against the trusted
  // registry, BEFORE any account/pool selection. The selected physical model is
  // frozen into the effective request/route; account failover can never change it.
  const reasoningRequest = canonical.inference.reasoning ?? reasoningRequestFromWire({});
  const selection = selectModelForRequest(mapped.modelId, provider.name, dependencies.required ?? [], canonical);
  const modelEvidence = selection.model;
  // Stage 1b (#70): translate the canonical reasoning intent into the selected
  // model's native control through the provider-owned boundary, BEFORE account
  // selection, so the decision and trace carry deterministic mapping metadata.
  // Fail-closed: an untranslatable explicit intent never becomes a silent
  // downgrade; the typed reason surfaces on the existing profile error contract.
  let resolvedReasoning: ReturnType<typeof resolveReasoning>;
  try {
    resolvedReasoning = resolveReasoning(reasoningRequest, modelEvidence.reasoning);
  } catch (error) {
    if (error instanceof ReasoningTranslationError) {
      throw new ProfileActivationError(
        "capability-rejected",
        `Reasoning translation failed (${error.code}: ${provider.name}/${modelEvidence.identity.upstreamModelId})`,
        translationFailureCode(error.code),
      );
    }
    throw error;
  }
  const activated = activateProfile(policy.snapshot.profiles, {
    profileId: session.profileId,
    name: session.profileName,
    requestedModel: canonical.requestedModel,
    required: dependencies.required ?? [],
    baseCapabilities: modelEvidence.capabilities,
  });
  const capabilities = activated.capabilities;
  const adapterId = adapterIdFor(provider);
  const route: RouteRecord = {
    role: activated.role,
    providerId: provider.name,
    modelId: activated.modelId,
    adapterId,
    credentialRef: { kind: "handle", handle: "cred-profile-policy" },
    capabilities,
    reasoningEvidence: modelEvidence.reasoning,
  };
  decideRoute({
    requestId: canonical.id,
    route,
    required: dependencies.required ?? [],
    configFingerprint: dependencies.configFingerprint,
    resolvedReasoning,
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
            reasoningEvidence: modelEvidence.reasoning,
            resolvedReasoning,
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
          onTrace: (trace) => dependencies.traces.push(trace, session.profileName, selection.decision, resolvedReasoning),
        });
      },
      countTokens: () => Promise.resolve(conservativeTokenCount(effectiveRequest)),
    },
  };
}

function envCredentialName(handle: string): string | undefined {
  return handle.startsWith("env:") ? handle.slice(4) : undefined;
}

function translationFailureCode(code: "unsupported-reasoning" | "no-budget-policy"): "reasoning-translation-unsupported" | "reasoning-budget-policy-missing" {
  return code === "no-budget-policy" ? "reasoning-budget-policy-missing" : "reasoning-translation-unsupported";
}

/**
 * Builds the reasoning requirement for #68 eligibility from the canonical
 * request (#70): explicit non-OFF/non-AUTO intents demand reasoning; when the
 * request also uses tools, reasoning must interleave with tool use (#24/#67
 * evidence gate). OFF and AUTO delegate to the decoded capability list.
 */
function reasoningRequirementFrom(request: CanonicalRequest, required: readonly CapabilityRequirement[]): ReasoningRequirement | undefined {
  const reasoning = request.inference.reasoning;
  if (reasoning !== undefined && reasoning.intent !== "OFF" && reasoning.intent !== "AUTO") {
    return { required: true, ...(request.tools.length > 0 ? { withTools: true } : {}) };
  }
  return required.includes("reasoning") ? { required: true } : undefined;
}

/**
 * Runs the deterministic model selection engine (#68) for an exact pinned
 * model, mapping typed selection failures onto the existing profile error
 * contract (`capability-rejected` plus the actionable `modelFailure` reason).
 * #70 additionally fails closed when the canonical reasoning intent cannot be
 * translated for the selected model (unsupported control or missing budget
 * policy), never silently.
 */
function selectModelForRequest(
  modelId: string,
  providerId: string,
  required: readonly CapabilityRequirement[],
  request: CanonicalRequest,
): ModelSelectionResult {
  try {
    const reasoning = reasoningRequirementFrom(request, required);
    return selectModel({
      accessProviderId: providerId,
      exactModelId: modelId,
      requiredCapabilities: required,
      ...(reasoning === undefined ? {} : { reasoning }),
    });
  } catch (error) {
    if (isModelSelectionError(error)) {
      throw new ProfileActivationError(
        "capability-rejected",
        `Model selection failed (${error.code}: ${providerId}/${modelId})`,
        error.code,
      );
    }
    if (error instanceof ReasoningTranslationError) {
      throw new ProfileActivationError(
        "capability-rejected",
        `Reasoning translation failed (${error.code}: ${providerId}/${modelId})`,
        translationFailureCode(error.code),
      );
    }
    throw error;
  }
}

async function credentialSnapshots(
  dependencies: ProfileRouteDependencies,
  accounts: readonly AccountRecord[],
  environment: NodeJS.ProcessEnv,
): Promise<ReadonlyMap<string, CredentialSnapshot>> {
  const entries: [string, CredentialSnapshot][] = [];
  for (const account of accounts) {
    entries.push([account.credentialHandle, await snapshotForAccount(account, dependencies, environment)]);
  }
  return new Map(entries);
}

async function snapshotForAccount(
  account: AccountRecord,
  dependencies: ProfileRouteDependencies,
  environment: NodeJS.ProcessEnv,
): Promise<CredentialSnapshot> {
    const envName = envCredentialName(account.credentialHandle);
    if (envName !== undefined) {
      return { present: Boolean(environment[envName]), generation: Math.max(account.credentialGeneration, 1) };
    }
    try {
      const metadata = await dependencies.broker.prepare(account.credentialHandle);
      return {
        present: metadata.generation >= 1,
        generation: metadata.generation,
        ...(metadata.expiresAt === undefined ? {} : { expiresAt: metadata.expiresAt }),
      };
    } catch {
      return { present: false, generation: 0 };
    }
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
  if (provider.integrationMode === "oauth" || provider.integrationMode === "bridge") {
    const scoped = provider.integrationMode === "oauth"
      ? await dependencies.broker.bind(route.credentialHandle, route.credentialGeneration)
      : await dependencies.broker.bind(route.credentialHandle, route.credentialGeneration).catch(() => undefined);
    try {
      const adapter = createProviderAdapter({
        provider,
        request: dependencies.fetch ?? fetch,
        environment,
        ...(scoped === undefined ? {} : {
          accessToken: scoped.accessToken,
          ...(scoped.accountId === undefined ? {} : { accountId: scoped.accountId }),
        }),
      });
      yield* adapter.invoke(request, decision, signal);
    } finally {
      scoped?.dispose();
    }
    return;
  }
  const envName = envCredentialName(route.credentialHandle);
  const envDecision = envName === undefined
    ? decision
    : { ...decision, credentialRef: parseCredentialRef(`env:${envName}`) };
  const adapter = createProviderAdapter({ provider, request: dependencies.fetch ?? fetch, environment });
  yield* adapter.invoke(request, envDecision, signal);
}
