import type { CapabilityRequirement } from "../../core/capabilities.js";
import type { CompatibilityState, ModelEvidence } from "../../registry/model-registry.js";
import type { ClaimFeature } from "../../canary/claim.js";
import type { EffectiveCompatibility } from "../../compatibility/types.js";

/**
 * #124: Effective Compatibility Registry snapshot consumed by #68 selection.
 * Keyed by registry logicalId; each entry carries per-feature effective
 * answers (trust/health/freshness/quarantine/enforcement kept separate). When
 * supplied, the ECR is the compatibility AUTHORITY — the static
 * `model.compatibility.state` becomes seed/reference data only.
 */
export type EffectiveSelectionSnapshot = ReadonlyMap<string, ReadonlyMap<ClaimFeature, EffectiveCompatibility>>;

/**
 * Minimal reasoning requirement for #68 eligibility. #70 owns the canonical
 * `ReasoningIntent` (src/core/reasoning.ts); this contract only carries what
 * eligibility needs: whether reasoning is demanded and whether it must
 * interleave with tool use.
 */
export type ReasoningRequirement = Readonly<{
  /** Reasoning is demanded by the request (e.g. thinking enabled). */
  required: boolean;
  /** Reasoning must interleave with tool use. */
  withTools?: boolean;
}>;

/**
 * Data-only, deterministic model selection input. Consumes explicit runtime
 * (decoded request), policy (compatibility/experimental opt-in), and trusted
 * registry evidence inputs only — never prompt text or an LLM classifier.
 */
export type ModelSelectionInput = Readonly<{
  /** Trusted registry access provider id (e.g. `codex`, `cline`, `openrouter`). */
  accessProviderId: string;
  /** Preferred upstream/model family affinity. #69 owns cross-family fallback policy. */
  preferredFamily?: string;
  /** Exact physical model pin. Bypasses candidate ranking but still validates. */
  exactModelId?: string;
  /** Required protocol capabilities from the decoded request. */
  requiredCapabilities: readonly CapabilityRequirement[];
  /** Reasoning requirement from the canonical request (#70 feeds eligibility). */
  reasoning?: ReasoningRequirement;
  /**
   * Explicit opt-in for EXPERIMENTAL compatibility candidates on the
   * candidate-selection path. Default normal-user policy is VERIFIED only.
   * An explicit exact-model pin is itself an opt-in for that exact model.
   */
  allowExperimental?: boolean;
}>;

/**
 * Allowlisted candidate assessment metadata. Flattened by design: no
 * `identity`/`token`/`secret`/`prompt`/`response` keys so the trace passes the
 * control-plane `assertSecretFree` gate. Never contains credentials or account
 * identity.
 */
export type ModelCandidateAssessment = Readonly<{
  logicalId: string;
  accessProviderId: string;
  modelId: string;
  modelFamily?: string;
  compatibilityState: CompatibilityState;
  capabilityPass: boolean;
  missingCapabilities?: readonly CapabilityRequirement[];
  reasoningPass: boolean;
  reasoningFailure?: string;
  compatibilityPass: boolean;
  compatibilityFailure?: string;
  /** #124: which authority produced the compatibility answer. */
  authority?: "ecr" | "seed";
  /** #124: worst required-feature effective label when the ECR is the authority. */
  effectiveLabel?: string;
  /** #124: distinct enforcement reason from the ECR (e.g. quarantine). */
  enforcementReason?: string;
  selected: boolean;
}>;

/** Secret-free decision trace for one model selection, usable by diagnostics. */
export type ModelSelectionTrace = Readonly<{
  /** `exact` when an exact physical model pin was resolved, else `candidates`. */
  source: "exact" | "candidates";
  selectedLogicalId: string;
  /** Stable, documented selection reason. */
  reason: string;
  candidates: readonly ModelCandidateAssessment[];
}>;

export type ModelSelectionResult = Readonly<{
  /** One exact trusted registry entry (the frozen physical model target). */
  model: ModelEvidence;
  decision: ModelSelectionTrace;
}>;
