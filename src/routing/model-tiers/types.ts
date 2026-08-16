/**
 * Provider- and model-family-scoped logical model tiers (#69).
 *
 * Tiers (`haiku`/`sonnet`/`opus`/`fable`) are portable model classes inside a
 * provider/model-family context — never upstream model ids and never a global
 * fixed mapping. Resolution is deterministic and contextual: access provider
 * first, then the parent model's model family when that provider exposes
 * multiple families, then trusted capability evidence. `fable` means the
 * configured/verified strongest tier for the current model family/access
 * path, not a global strongest-model search. No LLM classification anywhere.
 */

import type { ModelEvidence } from "../../registry/model-registry.js";
import type { ModelCandidateAssessment } from "../model-selection/types.js";

export const LOGICAL_TIERS = ["haiku", "sonnet", "opus", "fable"] as const;
export type LogicalTier = (typeof LOGICAL_TIERS)[number];

export function isLogicalTier(value: string): value is LogicalTier {
  return (LOGICAL_TIERS as readonly string[]).includes(value);
}

export function parseLogicalTier(value: string): LogicalTier | undefined {
  return isLogicalTier(value) ? value : undefined;
}

/**
 * Deterministic tier rank within one model family (weakest → strongest).
 * Rank is ordering metadata for documentation/traces only — never a quality
 * score and never a cross-provider comparison.
 */
export const TIER_ORDER: Readonly<Record<LogicalTier, number>> = Object.freeze({
  haiku: 0,
  sonnet: 1,
  opus: 2,
  fable: 3,
});

/**
 * Everything the resolver needs to avoid ambiguous aggregator behavior.
 * Access provider and model family are separate inputs on purpose.
 */
export type TierResolutionContext = Readonly<{
  requestedTier: LogicalTier;
  /** Trusted registry access provider id (e.g. `cline`, `codex`, `openrouter`). */
  accessProviderId: string;
  /** Parent/current physical model whose family scopes the tier request. */
  parentModelId?: string;
  /** Explicit model family; overrides parent-derived family when both present. */
  modelFamily?: string;
  /** User-pinned physical model target for this provider/family/tier (validated fail-closed). */
  explicitUserMapping?: string;
  /** Explicit cross-family fallback policy; never silent. */
  allowCrossFamilyFallback: boolean;
  /** Explicit cross-provider fallback policy; requires an explicit provider list. Never silent. */
  allowCrossProviderFallback: boolean;
}>;

/** Where the selected physical target came from. Visible in the decision trace. */
export type TierMappingSource = "user-override" | "reviewed-mapping" | "derived" | "fallback";

/**
 * Versioned tier mapping policy: reviewed/default entries keyed by
 * `accessProviderId|modelFamily|tier` → exact upstream model id. A revision is
 * immutable; a session pins the revision it resolved under so a background
 * catalog refresh can never silently change an active session's tier target
 * (#23 boundary).
 */
export type TierMappingPolicy = Readonly<{
  revision: number;
  entries: Readonly<Record<string, string>>;
}>;

/**
 * Secret-free decision trace for one tier resolution. Allowlisted metadata
 * only: never prompts, responses, credentials, or account identity.
 */
export type TierResolutionTrace = Readonly<{
  requestedTier: LogicalTier;
  accessProviderId: string;
  modelFamily?: string;
  parentModelId?: string;
  mappingSource: TierMappingSource;
  /** Exact selected physical target (registry logical id). */
  selectedLogicalId: string;
  /** Stable, documented selection reason. */
  reason: string;
  /** Immutable tier mapping policy revision the resolution used. */
  mappingRevision: number;
  /** Trusted registry document revision the resolution used. */
  registryRevision: number;
  /** Non-empty only when an explicitly enabled fallback scope was used. */
  fallbackReason?: string;
  /**
   * #68 candidate assessments from the derived/fallback evaluation (secret-
   * free). Populated when the tier target came from the #68 candidate path so
   * the EffectiveModelDecision can explain blocked alternatives without a
   * second selector.
   */
  assessments?: readonly ModelCandidateAssessment[];
}>;

export type TierResolutionResult = Readonly<{
  /** One exact trusted registry entry (the frozen physical model target). */
  model: ModelEvidence;
  trace: TierResolutionTrace;
}>;
