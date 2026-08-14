import type { CapabilityRequirement } from "../../core/capabilities.js";
import { assertSecretFree } from "../../control-plane/secret-free.js";
import {
  directProviderRegistry,
  findModelEvidence,
  modelsForProvider,
  type ModelEvidence,
  type RegistryDocument,
} from "../../registry/model-registry.js";
import { isModelSelectionError } from "../model-selection/errors.js";
import { selectModel } from "../model-selection/selector.js";
import type { ModelSelectionInput, ReasoningRequirement } from "../model-selection/types.js";
import { isTierResolutionError, TierResolutionError, type TierResolutionFailure } from "./errors.js";
import { defaultTierMapping, tierMappingKey } from "./mapping.js";
import type {
  TierMappingPolicy,
  TierMappingSource,
  TierResolutionContext,
  TierResolutionResult,
  TierResolutionTrace,
} from "./types.js";

export type TierResolutionDependencies = Readonly<{
  /** Trusted registry. Defaults to the shipped reviewed registry. */
  registry?: RegistryDocument;
  /** Reviewed/default tier mapping policy. Defaults to the frozen built-in document. */
  mapping?: TierMappingPolicy;
  /** Required protocol capabilities from the decoded request. */
  requiredCapabilities?: readonly CapabilityRequirement[];
  /** Reasoning requirement from the canonical request (#70 feeds eligibility). */
  reasoning?: ReasoningRequirement;
  /** Explicit opt-in for EXPERIMENTAL candidates on the derived path (#68 policy). */
  allowExperimental?: boolean;
  /**
   * Explicit ordered fallback provider list for cross-provider fallback. Never
   * derived implicitly: cross-provider fallback requires an explicit policy.
   */
  fallbackProviderIds?: readonly string[];
}>;

/**
 * Deterministic provider/family-scoped tier resolver (#69).
 *
 * Search order (identical inputs always produce the same result):
 * 1. Explicit user mapping for `(provider, family, tier)` — validated through
 *    the #68 exact-pin path; unknown/BROKEN/unsupported targets fail closed
 *    (`override-rejected`).
 * 2. Reviewed/default mapping entry — validated through #68; an entry without
 *    trusted/compatible evidence fails closed (`mapping-invalid`) and is never
 *    silently replaced.
 * 3. Derived candidate: deterministic #68 evaluation inside the same
 *    provider+family (default normal-user compatibility policy). A derived
 *    target is the deterministic #68 winner — it is not a claimed strength
 *    ranking; distinguishing multiple physical tiers inside one family
 *    requires a reviewed or user mapping.
 * 4. Explicit fallback scopes only when enabled by the caller (cross-family,
 *    then cross-provider with an explicit provider list); each fallback is
 *    recorded in the trace. No fallback scope → fail closed `tier-unavailable`.
 *
 * Never: global fixed fable, strongest-across-providers, silent cross-family
 * or cross-provider substitution, or any prompt/LLM classification.
 */
export function resolveTier(
  context: TierResolutionContext,
  dependencies: TierResolutionDependencies = {},
): TierResolutionResult {
  const registry = dependencies.registry ?? directProviderRegistry;
  const mapping = dependencies.mapping ?? defaultTierMapping;
  const requiredCapabilities = dependencies.requiredCapabilities ?? [];
  const family = resolveFamily(context, registry);

  const baseSelection: ModelSelectionInput = {
    accessProviderId: context.accessProviderId,
    requiredCapabilities,
    ...(dependencies.reasoning === undefined ? {} : { reasoning: dependencies.reasoning }),
    ...(dependencies.allowExperimental === true ? { allowExperimental: true } : {}),
  };

  // Stage 1: explicit user mapping wins when present and valid.
  if (context.explicitUserMapping !== undefined) {
    const model = exactTarget(
      baseSelection,
      context.explicitUserMapping,
      registry,
      "override-rejected",
      `User override rejected for ${context.accessProviderId}/${context.explicitUserMapping}`,
    );
    return settled(context, family, model, "user-override", "explicit-user-mapping", mapping, registry);
  }

  if (family === undefined) {
    // No provider/family context: cannot resolve contextually. Explicit
    // fallback scopes may still apply below only with an explicit policy.
    return fallbackOrFail(context, dependencies, baseSelection, registry, mapping, family, "family-unknown");
  }

  // Stage 2: reviewed/default mapping for the exact (provider, family, tier) key.
  const mappedModelId = mapping.entries[tierMappingKey(context.accessProviderId, family, context.requestedTier)];
  if (mappedModelId !== undefined) {
    const model = exactTarget(
      baseSelection,
      mappedModelId,
      registry,
      "mapping-invalid",
      `Reviewed tier mapping for ${context.accessProviderId}|${family}|${context.requestedTier} no longer has trusted/compatible evidence`,
    );
    return settled(context, family, model, "reviewed-mapping", "reviewed-mapping-match", mapping, registry);
  }

  // Stage 3: deterministic #68 candidate evaluation inside the same provider+family.
  try {
    const selection = selectModel({ ...baseSelection, preferredFamily: family }, registry);
    return settled(context, family, selection.model, "derived", "deterministic-family-candidate", mapping, registry);
  } catch (error) {
    if (!isModelSelectionError(error)) throw error;
    return fallbackOrFail(context, dependencies, baseSelection, registry, mapping, family, error.code);
  }
}

/** Derives the model family for the current execution context, deterministically. */
function resolveFamily(context: TierResolutionContext, registry: RegistryDocument): string | undefined {
  if (context.modelFamily !== undefined) return context.modelFamily;
  if (context.parentModelId !== undefined) {
    const parent = findModelEvidence(registry, context.accessProviderId, context.parentModelId);
    if (parent?.identity.modelFamily !== undefined) return parent.identity.modelFamily;
  }
  // Single-family provider: family is unambiguous from registry evidence alone.
  const families = new Set(
    modelsForProvider(registry, context.accessProviderId)
      .map((model) => model.identity.modelFamily)
      .filter((value): value is string => value !== undefined),
  );
  return families.size === 1 ? [...families][0] : undefined;
}

/**
 * Validates an explicit physical target through the #68 exact-pin path.
 * The exact pin is itself the EXPERIMENTAL opt-in for that exact model (#68);
 * BROKEN and unknown targets still fail closed.
 */
function exactTarget(
  baseSelection: ModelSelectionInput,
  modelId: string,
  registry: RegistryDocument,
  failure: TierResolutionFailure,
  message: string,
): ModelEvidence {
  try {
    return selectModel({ ...baseSelection, exactModelId: modelId }, registry).model;
  } catch (error) {
    if (isModelSelectionError(error)) {
      throw new TierResolutionError(failure, `${message} (${error.code})`, error.code);
    }
    throw error;
  }
}

/** Explicit fallback scopes, then fail closed. Every fallback is trace-visible. */
function fallbackOrFail(
  context: TierResolutionContext,
  dependencies: TierResolutionDependencies,
  baseSelection: ModelSelectionInput,
  registry: RegistryDocument,
  mapping: TierMappingPolicy,
  family: string | undefined,
  cause: string,
): TierResolutionResult {
  // Cross-family fallback: same access provider, all families. Requires an
  // unambiguous family context (else it would be an implicit cross-family jump).
  if (context.allowCrossFamilyFallback && family !== undefined) {
    try {
      const selection = selectModel({ ...baseSelection }, registry);
      return settled(
        context,
        family,
        selection.model,
        "fallback",
        "fallback-cross-family",
        mapping,
        registry,
        "cross-family (explicitly enabled)",
      );
    } catch (error) {
      if (!isModelSelectionError(error)) throw error;
    }
  }
  // Cross-provider fallback: explicit provider list only, deterministic order.
  if (context.allowCrossProviderFallback && dependencies.fallbackProviderIds !== undefined) {
    for (const providerId of dependencies.fallbackProviderIds) {
      if (providerId === context.accessProviderId) continue;
      const providerSelection: ModelSelectionInput = {
        ...baseSelection,
        accessProviderId: providerId,
      };
      try {
        const mappedModelId = family === undefined
          ? undefined
          : mapping.entries[tierMappingKey(providerId, family, context.requestedTier)];
        const model = mappedModelId === undefined
          ? selectModel(
              { ...providerSelection, ...(family === undefined ? {} : { preferredFamily: family }) },
              registry,
            ).model
          : exactTarget(providerSelection, mappedModelId, registry, "tier-unavailable", `Fallback mapping rejected for ${providerId}`);
        return settled(
          context,
          family,
          model,
          "fallback",
          "fallback-cross-provider",
          mapping,
          registry,
          `cross-provider (explicitly enabled): ${providerId}`,
        );
      } catch (error) {
        if (!isModelSelectionError(error) && !isTierResolutionError(error)) throw error;
        // Next explicitly enabled fallback provider.
      }
    }
  }
  throw new TierResolutionError(
    "tier-unavailable",
    `No eligible tier target for ${context.accessProviderId}/${family ?? "unknown-family"} tier ${context.requestedTier}`,
    cause,
  );
}

function settled(
  context: TierResolutionContext,
  family: string | undefined,
  model: ModelEvidence,
  mappingSource: TierMappingSource,
  reason: string,
  mapping: TierMappingPolicy,
  registry: RegistryDocument,
  fallbackReason?: string,
): TierResolutionResult {
  const trace: TierResolutionTrace = Object.freeze({
    requestedTier: context.requestedTier,
    accessProviderId: context.accessProviderId,
    ...(family === undefined ? {} : { modelFamily: family }),
    ...(context.parentModelId === undefined ? {} : { parentModelId: context.parentModelId }),
    mappingSource,
    selectedLogicalId: model.logicalId,
    reason,
    mappingRevision: mapping.revision,
    registryRevision: registry.registryRevision,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
  });
  assertSecretFree(trace);
  return Object.freeze({ model, trace });
}
