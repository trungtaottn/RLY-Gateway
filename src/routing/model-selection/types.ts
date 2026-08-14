import type { CapabilityRequirement } from "../../core/capabilities.js";
import type { CompatibilityState, ModelEvidence } from "../../registry/model-registry.js";

/**
 * Minimal reasoning intent for #68. #70 owns the full intent → provider
 * control translation; this contract only carries what eligibility needs:
 * whether reasoning is demanded and whether it must interleave with tool use.
 */
export type ReasoningIntent = Readonly<{
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
  /** Reasoning requirement/intent (#70 when available). */
  reasoning?: ReasoningIntent;
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
