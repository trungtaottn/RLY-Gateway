import { missingCapabilities } from "../../core/capabilities.js";
import { assertSecretFree } from "../../control-plane/secret-free.js";
import {
  directProviderRegistry,
  findModelEvidence,
  modelsForProvider,
  type ModelEvidence,
  type RegistryDocument,
} from "../../registry/model-registry.js";
import { requiredFeaturesForCapabilities } from "../../compatibility/features.js";
import type { EffectiveCompatibility } from "../../compatibility/types.js";
import { ModelSelectionError, type ModelSelectionFailure } from "./errors.js";
import type {
  EffectiveSelectionSnapshot,
  ModelCandidateAssessment,
  ModelSelectionInput,
  ModelSelectionResult,
  ModelSelectionTrace,
  ReasoningRequirement,
} from "./types.js";

/**
 * Compatibility policy:
 * - Default normal-user candidate policy is VERIFIED only (seed mapping).
 * - EXPERIMENTAL requires an explicit opt-in (`allowExperimental`) on the
 *   candidate path. An explicit exact-model pin is itself an explicit opt-in
 *   for that exact model's EXPERIMENTAL state.
 * - BROKEN is never eligible on any path.
 *
 * #124: when an Effective Compatibility Registry snapshot is supplied it is
 * the compatibility AUTHORITY; static `model.compatibility.state` is then
 * seed/reference data only and the ECR answers (trust/health/freshness/
 * quarantine/enforcement) decide eligibility. Quarantined required features
 * fail closed (no silent fallback) and only the separately documented
 * administrative quarantine-bypass policy may permit them — never the
 * experimental override.
 */

const REASONING_FAILURES = {
  "reasoning-not-supported": "reasoning-not-supported",
  "reasoning-with-tools-not-supported": "reasoning-with-tools-not-supported",
} as const;

const COMPATIBILITY_FAILURES = {
  broken: "broken",
  experimental: "experimental",
} as const;

function reasoningFailure(reasoning: ReasoningRequirement, model: ModelEvidence): string | undefined {
  if (reasoning.required && !model.reasoning.supported) return REASONING_FAILURES["reasoning-not-supported"];
  if (reasoning.withTools === true && !model.reasoning.reasoningWithTools) {
    return REASONING_FAILURES["reasoning-with-tools-not-supported"];
  }
  return undefined;
}

function compatibilityFailure(
  model: ModelEvidence,
  exact: boolean,
  allowExperimental: boolean | undefined,
): string | undefined {
  switch (model.compatibility.state) {
    case "BROKEN":
      return COMPATIBILITY_FAILURES.broken;
    case "EXPERIMENTAL":
      // Candidate path: default policy rejects EXPERIMENTAL unless explicitly
      // opted in. Exact path: the explicit pin is the opt-in.
      return exact || allowExperimental === true ? undefined : COMPATIBILITY_FAILURES.experimental;
    case "VERIFIED":
      return undefined;
  }
}

/**
 * #124 ECR-driven compatibility pass. Returns a failure string (or undefined)
 * plus the authority/effective/enforcement metadata for the trace.
 */
function effectiveCompatibilityFailure(
  model: ModelEvidence,
  input: ModelSelectionInput,
  exact: boolean,
  effective: ReadonlyMap<string, ReadonlyMap<import("../../canary/claim.js").ClaimFeature, EffectiveCompatibility>>,
): Readonly<{ failure?: string; effectiveLabel?: string; enforcementReason?: string }> {
  const features = requiredFeaturesForCapabilities(input.requiredCapabilities, input.reasoning);
  const effectiveForModel = effective.get(model.logicalId);
  if (effectiveForModel === undefined || effectiveForModel.size === 0) {
    // No ECR data for this model: seed mapping only (never authority by itself
    // when the runtime supplies the snapshot — the facade always populates it).
    const failure = compatibilityFailure(model, exact, input.allowExperimental);
    return failure === undefined ? {} : { failure };
  }
  let worst: EffectiveCompatibility | undefined;
  let blocked: EffectiveCompatibility | undefined;
  let missingRequired = false;
  for (const feature of features) {
    const result = effectiveForModel.get(feature);
    if (result === undefined) {
      missingRequired = true;
      continue;
    }
    if (worst === undefined || result.enforcement === "blocked") worst = result;
    if (result.enforcement === "blocked" && blocked === undefined) blocked = result;
  }
  if (missingRequired) {
    return { failure: COMPATIBILITY_FAILURES.experimental, enforcementReason: "missing-ecr-data-for-required-feature" };
  }
  const summary = worst ?? [...effectiveForModel.values()][0];
  if (blocked !== undefined) {
    return {
      failure: blocked.effective === "quarantined" ? COMPATIBILITY_FAILURES.broken : COMPATIBILITY_FAILURES.experimental,
      effectiveLabel: blocked.effective,
      enforcementReason: blocked.enforcementReason ?? "blocked-required-feature",
    };
  }
  return {
    ...(summary === undefined ? {} : { effectiveLabel: summary.effective }),
    ...(summary?.enforcement === "quarantine-bypass" ? { enforcementReason: "admin-quarantine-bypass" } : {}),
  };
}

function assess(
  model: ModelEvidence,
  input: ModelSelectionInput,
  exact: boolean,
  effective?: ReadonlyMap<string, ReadonlyMap<import("../../canary/claim.js").ClaimFeature, EffectiveCompatibility>>,
): ModelCandidateAssessment {
  const missing = missingCapabilities(model.capabilities, input.requiredCapabilities);
  const reasoning = input.reasoning ?? { required: false };
  const reasoningFail = reasoningFailure(reasoning, model);
  const ecr = effective === undefined ? undefined : effectiveCompatibilityFailure(model, input, exact, effective);
  const compatFail = ecr?.failure ?? (effective === undefined ? compatibilityFailure(model, exact, input.allowExperimental) : undefined);
  return Object.freeze({
    logicalId: model.logicalId,
    accessProviderId: model.identity.accessProviderId,
    modelId: model.identity.upstreamModelId,
    ...(model.identity.modelFamily === undefined ? {} : { modelFamily: model.identity.modelFamily }),
    compatibilityState: model.compatibility.state,
    capabilityPass: missing.length === 0,
    ...(missing.length === 0 ? {} : { missingCapabilities: Object.freeze([...missing]) }),
    reasoningPass: reasoningFail === undefined,
    ...(reasoningFail === undefined ? {} : { reasoningFailure: reasoningFail }),
    compatibilityPass: compatFail === undefined,
    ...(compatFail === undefined ? {} : { compatibilityFailure: compatFail }),
    ...(effective === undefined ? {} : { authority: "ecr" as const }),
    ...(ecr?.effectiveLabel === undefined ? {} : { effectiveLabel: ecr.effectiveLabel }),
    ...(ecr?.enforcementReason === undefined ? {} : { enforcementReason: ecr.enforcementReason }),
    selected: false,
  });
}

/** Most actionable typed failure across the assessed candidates, in filter order. */
function failureFor(assessments: readonly ModelCandidateAssessment[]): ModelSelectionFailure {
  for (const assessment of assessments) {
    if (assessment.missingCapabilities !== undefined && assessment.missingCapabilities.length > 0) {
      return "capability-unsupported";
    }
    if (assessment.reasoningFailure !== undefined) return "reasoning-unsupported";
    if (assessment.compatibilityFailure !== undefined) return "compatibility-rejected";
  }
  return "no-eligible-candidate";
}

export function createModelSelectionTrace(trace: ModelSelectionTrace): ModelSelectionTrace {
  const frozen: ModelSelectionTrace = Object.freeze({
    source: trace.source,
    selectedLogicalId: trace.selectedLogicalId,
    reason: trace.reason,
    candidates: Object.freeze(trace.candidates.map((candidate) => Object.freeze({
      logicalId: candidate.logicalId,
      accessProviderId: candidate.accessProviderId,
      modelId: candidate.modelId,
      ...(candidate.modelFamily === undefined ? {} : { modelFamily: candidate.modelFamily }),
      compatibilityState: candidate.compatibilityState,
      capabilityPass: candidate.capabilityPass,
      ...(candidate.missingCapabilities === undefined
        ? {}
        : { missingCapabilities: Object.freeze([...candidate.missingCapabilities]) }),
      reasoningPass: candidate.reasoningPass,
      ...(candidate.reasoningFailure === undefined ? {} : { reasoningFailure: candidate.reasoningFailure }),
      compatibilityPass: candidate.compatibilityPass,
      ...(candidate.compatibilityFailure === undefined ? {} : { compatibilityFailure: candidate.compatibilityFailure }),
      ...(candidate.authority === undefined ? {} : { authority: candidate.authority }),
      ...(candidate.effectiveLabel === undefined ? {} : { effectiveLabel: candidate.effectiveLabel }),
      ...(candidate.enforcementReason === undefined ? {} : { enforcementReason: candidate.enforcementReason }),
      selected: candidate.selected,
    }))),
  });
  assertSecretFree(frozen);
  return frozen;
}

/**
 * Deterministic model capability matching engine (#68). Selects one eligible
 * physical model from the trusted registry BEFORE account/pool selection.
 *
 * Pipeline (hard eligibility first, ranking after):
 * 1. Candidate retrieval from trusted registry evidence only.
 * 2. Required protocol capabilities (existing `CapabilityRequirement` semantics).
 * 3. Reasoning semantics against `ReasoningCapabilityEvidence`.
 * 4. Compatibility state policy (BROKEN always rejected; EXPERIMENTAL by
 *    default policy on the candidate path).
 * 5. Deterministic ranking: registry document order. #69 owns tier/family
 *    preference ranking and cross-family fallback policy.
 *
 * Fail-closed: missing evidence, cross-provider lookups, unsatisfied
 * capabilities, unsupported reasoning, or rejected compatibility states throw
 * a typed `ModelSelectionError`; identical inputs always produce the same
 * selection and the same decision reason.
 */
export function selectModel(
  input: ModelSelectionInput,
  registry: RegistryDocument = directProviderRegistry,
  dependencies?: Readonly<{
    /** #124: ECR snapshot (logicalId → per-feature effective answers). */
    effective?: EffectiveSelectionSnapshot;
  }>,
): ModelSelectionResult {
  const exact = input.exactModelId !== undefined;
  let candidates: readonly ModelEvidence[];
  if (exact) {
    const evidence = findModelEvidence(registry, input.accessProviderId, input.exactModelId ?? "");
    if (evidence === undefined) {
      throw new ModelSelectionError(
        "unknown-exact-model",
        `No trusted evidence for ${input.accessProviderId}/${input.exactModelId}`,
      );
    }
    candidates = [evidence];
  } else {
    let providerModels = modelsForProvider(registry, input.accessProviderId);
    if (providerModels.length === 0) {
      throw new ModelSelectionError(
        "no-trusted-evidence",
        `No trusted model evidence for access provider ${input.accessProviderId}`,
      );
    }
    if (input.preferredFamily !== undefined) {
      const familyModels = providerModels.filter((model) => model.identity.modelFamily === input.preferredFamily);
      if (familyModels.length === 0) {
        throw new ModelSelectionError(
          "no-eligible-candidate",
          `No ${input.preferredFamily} family candidate for access provider ${input.accessProviderId}`,
        );
      }
      providerModels = familyModels;
    }
    candidates = providerModels;
  }

  const assessments = candidates.map((model) => assess(model, input, exact, dependencies?.effective));
  const eligible = assessments.filter(
    (assessment) => assessment.capabilityPass && assessment.reasoningPass && assessment.compatibilityPass,
  );
  if (eligible.length === 0) {
    throw new ModelSelectionError(failureFor(assessments));
  }
  // Deterministic tie-break: registry document (reviewed evidence) order.
  // Identical evidence + policy + request inputs select the same entry.
  const selectedIndex = candidates.findIndex((model) => model.logicalId === eligible[0]?.logicalId);
  const selected = candidates[selectedIndex];
  if (selected === undefined) throw new ModelSelectionError("no-eligible-candidate");

  const marked: ModelCandidateAssessment[] = assessments.map((assessment) =>
    assessment.logicalId === selected.logicalId ? Object.freeze({ ...assessment, selected: true }) : assessment,
  );
  const decision = createModelSelectionTrace({
    source: exact ? "exact" : "candidates",
    selectedLogicalId: selected.logicalId,
    reason: exact
      ? "exact-evidence"
      : input.preferredFamily === undefined
        ? "capability-and-compatibility-match"
        : "family-capability-and-compatibility-match",
    candidates: marked,
  });
  return Object.freeze({ model: selected, decision });
}
