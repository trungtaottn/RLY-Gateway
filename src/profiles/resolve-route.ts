import type { CanonicalEvent } from "../core/canonical-event.js";
import type { CanonicalRequest } from "../core/canonical-request.js";
import type { CapabilityRequirement } from "../core/capabilities.js";
import { agentPseudonym, type AgentContext } from "../core/agent-context.js";
import { reasoningRequestFromWire } from "../core/reasoning.js";
import { decideRoute, type RouteRecord } from "../core/router.js";
import { conservativeTokenCount } from "../core/token-counting.js";
import type { ControlPlaneStore } from "../control-plane/store.js";
import type { AccountRecord, ProfileRecord, ProviderRecord } from "../control-plane/types.js";
import type { CredentialBroker } from "../credentials/broker.js";
import { parseCredentialRef } from "../credentials/credential-ref.js";
import type { CanonicalUpstream } from "../protocols/anthropic/fake-upstream.js";
import { adapterIdFor, createProviderAdapter } from "../providers/dispatch.js";
import { ReasoningTranslationError, resolveReasoning } from "../providers/reasoning.js";
import { directProviderRegistry, type RegistryDocument } from "../registry/model-registry.js";
import { createModelProjectionTrace, resolveProjection } from "../routing/model-projection/project.js";
import type { ModelProjectionTrace } from "../routing/model-projection/types.js";
import { toRouteDecision, type EffectiveRoute } from "../routing/effective-route.js";
import type { CredentialSnapshot } from "../routing/eligibility/reasons.js";
import { isModelSelectionError } from "../routing/model-selection/errors.js";
import { selectModel } from "../routing/model-selection/selector.js";
import type { ModelSelectionResult, ReasoningRequirement } from "../routing/model-selection/types.js";
import { streamPoolRequest } from "../routing/pools/execute.js";
import type { RouteSelector } from "../routing/pools/selector.js";
import { isTierResolutionError } from "../routing/model-tiers/errors.js";
import { resolveTier } from "../routing/model-tiers/resolver.js";
import { LOGICAL_TIERS, parseLogicalTier, type LogicalTier, type TierResolutionTrace } from "../routing/model-tiers/types.js";
import { activateProfile, findProfileById, inspectLaunchableProfile } from "./activate.js";
import type { AgentExecutionContextRegistry, ExecutionContext, ParentExecutionReference } from "./agent-contexts.js";
import { ProfileActivationError } from "./errors.js";
import { resolveProfileRole } from "./helper-map.js";
import type { LaunchSession } from "./sessions.js";
import type { AgentTraceLinkage, RouteTraceRing } from "./traces.js";

export type ProfileRouteDependencies = Readonly<{
  store: ControlPlaneStore;
  broker: CredentialBroker;
  selector: RouteSelector;
  traces: RouteTraceRing;
  configFingerprint: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  required?: readonly CapabilityRequirement[];
  /** Session-scoped Claude Code agent execution contexts (#71). */
  agentContexts?: AgentExecutionContextRegistry;
}>;

/** Profile-route dependencies plus an optional trusted registry override (#72). */
export type ProjectedRouteDependencies = ProfileRouteDependencies & Readonly<{ registry?: RegistryDocument }>;

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
  const pool = policy.snapshot.pools.find((item) => item.id === inspected.poolId);
  if (!pool) throw new ProfileActivationError("profile-has-no-pool");
  const provider = policy.snapshot.providers.find((item) => item.id === pool.providerId);
  if (!provider) throw new ProfileActivationError("profile-has-no-pool");
  // #71: a subagent request inherits the parent agent's frozen physical
  // model/family for #69 tier family affinity. Parent resolution never
  // mutates the parent's own context: each request resolves independently and
  // only records its own context after success (see below).
  const parentReference = resolveParentExecutionReference(canonical.agent, session, dependencies.agentContexts);
  // #69: a logical tier request (`model: fable`) resolves contextually inside
  // the profile's access provider and parent model family BEFORE #68 exact
  // selection. Non-tier requests keep the existing role/helper mapping.
  const tierResolution = mapped === undefined
    ? resolveTierForRequest(canonical, provider.name, inspected.profile, dependencies.required ?? [], parentReference?.context)
    : undefined;
  const resolvedModelId = mapped?.modelId ?? tierResolution?.modelId;
  const resolvedRole = mapped?.role ?? tierResolution?.role;
  if (resolvedModelId === undefined || resolvedRole === undefined) {
    throw new ProfileActivationError("role-unmapped");
  }
  // Stage 1: deterministic model capability selection (#68) against the trusted
  // registry, BEFORE any account/pool selection. The selected physical model is
  // frozen into the effective request/route; account failover can never change it.
  const reasoningRequest = canonical.inference.reasoning ?? reasoningRequestFromWire({});
  const selection = selectModelForRequest(resolvedModelId, provider.name, dependencies.required ?? [], canonical);
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
    ...(tierResolution === undefined ? {} : { resolved: { role: tierResolution.role, modelId: tierResolution.modelId } }),
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
  // #71: record the resolved execution context for this agent so nested and
  // subsequent subagents inherit the correct provider/family affinity. The
  // physical model is frozen at this point; credentials/account ids are never
  // stored. Only fully resolved requests (activation + route decision) record.
  const agentContext = canonical.agent;
  if (dependencies.agentContexts !== undefined && agentContext?.claudeSessionId !== undefined && agentContext.agentId !== undefined) {
    dependencies.agentContexts.record(session, {
      claudeSessionId: agentContext.claudeSessionId,
      agentId: agentContext.agentId,
      ...(agentContext.parentAgentId === undefined ? {} : { parentAgentId: agentContext.parentAgentId }),
      role: agentContext.parentAgentId === undefined ? "main" : "subagent",
      accessProviderId: provider.name,
      resolvedModelId: activated.modelId,
      ...(modelEvidence.identity.modelFamily === undefined ? {} : { modelFamily: modelEvidence.identity.modelFamily }),
      ...(tierResolution === undefined ? {} : { effectiveTier: tierResolution.role }),
      ...(tierResolution === undefined ? {} : { mappingRevision: tierResolution.trace.mappingRevision }),
      ...(tierResolution === undefined ? {} : { registryRevision: tierResolution.trace.registryRevision }),
      updatedAt: new Date().toISOString(),
    });
  }
  // #71: allowlisted agent linkage for diagnostics — pseudonyms only, plus the
  // parent model/family that scoped tier resolution. Never prompts or identity.
  const agentLinkage = agentTraceLinkage(agentContext, parentReference);
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
          onTrace: (trace) => dependencies.traces.push(trace, session.profileName, selection.decision, resolvedReasoning, tierResolution?.trace, agentLinkage),
        });
      },
      countTokens: () => Promise.resolve(conservativeTokenCount(effectiveRequest)),
    },
  };
}

/**
 * Routes a request whose model is an RLY projection id (`claude-rly-...`,
 * #72) to one exact access-provider/model target and the pinned provider pool.
 *
 * The projection id is a user-selection handle only: the explicit reverse
 * mapping (`resolveProjection`) yields the exact physical target from the
 * session's pinned model universe, then the existing two-stage boundary runs
 * unchanged — #68 exact model selection + #70 reasoning translation, followed
 * by pool/account selection inside the pinned pool. Fail-closed: an unknown,
 * removed, BROKEN, or EXPERIMENTAL-ineligible projection (or a provider/pool
 * that is no longer in the current policy) raises a typed error and never
 * substitutes another model or provider.
 */
export async function resolveProjectedModelRoute(
  canonical: CanonicalRequest,
  session: LaunchSession,
  dependencies: ProjectedRouteDependencies,
): Promise<ResolvedProfileRoute> {
  const universe = session.modelUniverse;
  const registry = dependencies.registry ?? directProviderRegistry;
  const resolved = resolveProjection(canonical.requestedModel, universe, registry);
  if (resolved === undefined) {
    throw new ProfileActivationError(
      "model-unavailable",
      `RLY projection model is not available in this session (${canonical.requestedModel})`,
    );
  }
  const policy = dependencies.store.currentPolicy();
  if (!policy) throw new ProfileActivationError("profile-not-found");
  const pool = policy.snapshot.pools.find((item) => item.id === resolved.binding.poolId);
  const provider = policy.snapshot.providers.find((item) => item.id === resolved.binding.providerId);
  if (pool === undefined || provider === undefined || !provider.enabled) {
    throw new ProfileActivationError(
      "model-unavailable",
      `Projection target is no longer available (${resolved.binding.providerName}/${resolved.projection.upstreamModelId})`,
    );
  }
  // Stage 1: deterministic exact model selection (#68) against the trusted
  // registry. Re-validates capabilities/compatibility/reasoning for the exact
  // physical target — a BROKEN or unsupported target fails closed here.
  const reasoningRequest = canonical.inference.reasoning ?? reasoningRequestFromWire({});
  const selection = selectModelForRequest(
    resolved.evidence.identity.upstreamModelId,
    provider.name,
    dependencies.required ?? [],
    canonical,
    registry,
  );
  const modelEvidence = selection.model;
  // Stage 1b (#70): translate the canonical reasoning intent into the selected
  // model's native control; fail closed on untranslatable explicit intents.
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
  const capabilities = modelEvidence.capabilities;
  const adapterId = adapterIdFor(provider);
  const route: RouteRecord = {
    role: "unknown",
    providerId: provider.name,
    modelId: modelEvidence.identity.upstreamModelId,
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
    requestedModel: modelEvidence.identity.upstreamModelId,
    modelRole: "unknown",
  });
  const projectionTrace: ModelProjectionTrace = createModelProjectionTrace(resolved.projection, universe);
  return {
    route,
    upstream: {
      invoke: (_ignored: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent> => {
        return streamPoolRequest({
          selector: dependencies.selector,
          store: dependencies.store,
          request: effectiveRequest,
          select: {
            poolId: resolved.binding.poolId,
            policy,
            required: dependencies.required ?? [],
            capabilities,
            modelId: modelEvidence.identity.upstreamModelId,
            adapterId,
            role: "unknown",
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
          onTrace: (trace) => dependencies.traces.push(trace, session.profileName, selection.decision, resolvedReasoning, undefined, undefined, projectionTrace),
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
 * Parent/current model role order for tier family context (#69): the
 * profile's main model first, then fallback roles, then configured tier
 * overrides. The parent model's registry evidence supplies the model family
 * that scopes a tier request on multi-family access providers.
 */
const PARENT_ROLE_ORDER: readonly string[] = ["primary", "reasoning", "fast", ...LOGICAL_TIERS];

function parentModelForProfile(modelRoles: Readonly<Record<string, string>>): string | undefined {
  for (const role of PARENT_ROLE_ORDER) {
    const modelId = modelRoles[role];
    if (modelId !== undefined) return modelId;
  }
  return undefined;
}

/**
 * Resolves the parent execution context for #69 tier family affinity (#71).
 *
 * A subagent request inherits the parent agent's frozen physical model:
 * exact `(session, parentAgentId)` match first, then the session's main-agent
 * context (the session's current/default context). With no recorded context
 * the caller falls back to the profile default model — the launch session's
 * unambiguous default execution context. The fallback never selects another
 * subagent's context, so one subagent's model can never leak into another's
 * tier resolution. When the profile default itself cannot determine a parent
 * family on a multi-family provider, #69 fails closed (`family-unknown` →
 * `tier-unavailable`) rather than choosing a global strongest model.
 */
function resolveParentExecutionReference(
  agent: AgentContext | undefined,
  session: LaunchSession,
  registry: AgentExecutionContextRegistry | undefined,
): ParentExecutionReference | undefined {
  if (agent === undefined || agent.claudeSessionId === undefined || registry === undefined) return undefined;
  // Main-agent requests have no parent; #69 uses the profile default parent.
  if (agent.parentAgentId === undefined) return undefined;
  const exact = registry.resolve(session, agent.claudeSessionId, agent.parentAgentId);
  if (exact !== undefined) return { context: exact, source: "parent-agent" };
  const main = registry.mainContext(session, agent.claudeSessionId);
  if (main !== undefined) return { context: main, source: "session-default" };
  return undefined;
}

/** Allowlisted agent linkage for the decision trace (#71). */
function agentTraceLinkage(
  agent: AgentContext | undefined,
  parent: ParentExecutionReference | undefined,
): AgentTraceLinkage | undefined {
  if (agent === undefined) return undefined;
  return Object.freeze({
    claudeSessionPseudonym: agentPseudonym(agent.claudeSessionId ?? agent.agentId ?? "session"),
    agentPseudonym: agentPseudonym(agent.agentId ?? agent.claudeSessionId ?? "agent"),
    ...(agent.parentAgentId === undefined ? {} : { parentAgentPseudonym: agentPseudonym(agent.parentAgentId) }),
    contextSource: parent?.source ?? "profile-default",
    ...(parent === undefined ? {} : { parentModelId: parent.context.resolvedModelId }),
    ...(parent === undefined ? {} : { parentModelFamily: parent.context.modelFamily }),
  });
}

/**
 * Resolves a logical tier request (#69) inside the current execution context:
 * access provider first, then the parent model's family, then trusted tier
 * mapping/capability evidence. The tier target is an exact physical model that
 * then goes through the same #68 exact-selection and #70 reasoning stages.
 * Fail-closed: an unresolvable tier maps onto the existing profile error
 * contract (`tier-unavailable` plus the typed tier reason).
 *
 * #71: a subagent request passes the parent agent's frozen physical
 * model/family (from the execution-context registry) instead of the profile
 * default; the main request keeps the profile default parent (#69).
 */
function resolveTierForRequest(
  canonical: CanonicalRequest,
  providerName: string,
  profile: ProfileRecord,
  required: readonly CapabilityRequirement[],
  parent?: ExecutionContext,
): Readonly<{ role: LogicalTier; modelId: string; trace: TierResolutionTrace }> {
  const tier = parseLogicalTier(canonical.requestedModel);
  if (tier === undefined) throw new ProfileActivationError("role-unmapped");
  const parentModelId = parent?.resolvedModelId ?? parentModelForProfile(profile.modelRoles);
  const parentFamily = parent?.modelFamily;
  const reasoning = reasoningRequirementFrom(canonical, required);
  try {
    const resolution = resolveTier({
      requestedTier: tier,
      accessProviderId: providerName,
      ...(parentModelId === undefined ? {} : { parentModelId }),
      ...(parentFamily === undefined ? {} : { modelFamily: parentFamily }),
      ...(profile.modelRoles[tier] === undefined ? {} : { explicitUserMapping: profile.modelRoles[tier] }),
      allowCrossFamilyFallback: false,
      allowCrossProviderFallback: false,
    }, {
      requiredCapabilities: required,
      ...(reasoning === undefined ? {} : { reasoning }),
    });
    return Object.freeze({ role: tier, modelId: resolution.model.identity.upstreamModelId, trace: resolution.trace });
  } catch (error) {
    if (isTierResolutionError(error)) {
      throw new ProfileActivationError(
        "tier-unavailable",
        `Tier resolution failed (${error.code}: ${providerName}/${tier})`,
        undefined,
        error.code,
        error.causeCode,
      );
    }
    throw error;
  }
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
  registry: RegistryDocument = directProviderRegistry,
): ModelSelectionResult {
  try {
    const reasoning = reasoningRequirementFrom(request, required);
    return selectModel({
      accessProviderId: providerId,
      exactModelId: modelId,
      requiredCapabilities: required,
      ...(reasoning === undefined ? {} : { reasoning }),
    }, registry);
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
