/**
 * EffectiveModelDecision — W3-T3 model-control plane (#127).
 *
 * ONE typed, secret-free decision object produced BEFORE account selection for
 * every supported RLY model-routing request. It assembles the typed selector
 * intent (#125), profile/session/subagent context (#69/#71), the frozen
 * physical model target (#68), reasoning translation (#70), the Effective
 * Compatibility Registry authority result (#124), the provider→pool binding
 * and session-pinned universe (#72), and profile-scoped view/env/settings
 * ownership state (#126) into a single explainable control-plane output.
 *
 * The decision is the FINAL model-control output before account selection:
 * the physical access-provider/model target and the reasoning policy are
 * frozen here and the existing pool/account `RouteSelector` runs downstream
 * against that frozen target. Account retry/failover can never change the
 * physical model or the selector meaning.
 *
 * Privacy: this object carries allowlisted metadata ONLY — selector kind/
 * source, provider/model/family/tier/projection identities, reasoning control
 * metadata, ECR trust/enforcement metadata, pool binding, and revisions. It
 * NEVER carries prompts, responses, reasoning text, credentials, auth
 * headers, raw account identity, or full user settings content. Field names
 * are chosen so the whole object passes the control-plane `assertSecretFree`
 * gate (no `token`/`secret`/`identity`/`prompt`/`response`/`email`/
 * `authorization` keys).
 */

import type { CapabilityRequirement } from "../../core/capabilities.js";
import type { CompatibilityState } from "../../registry/model-registry.js";
import type { ResolvedReasoning } from "../../core/reasoning.js";
import type { EffectiveCompatibilityLabel, EffectiveEnforcement } from "../../compatibility/types.js";
import type { ModelIntentTrace, ClientNativeAlias } from "../model-intent/types.js";
import type { TierResolutionTrace, LogicalTier } from "../model-tiers/types.js";
import type { ModelProjectionTrace } from "../model-projection/types.js";
import type { ParentContextSource } from "../../profiles/agent-contexts.js";
import type { SettingsOwnershipSummary } from "../../runtime/claude-overlay.js";

export const MODEL_DECISION_SCHEMA_VERSION = 1 as const;

/**
 * Deterministic precedence among the model-decision sources (#127). The
 * incoming selector is classified (#125) and the request's explicit selection
 * always wins; the other sources are recorded as consumed/visible state so no
 * hidden string/env override silently wins. Highest → lowest:
 *
 * 1. explicit exact selection      (projection id or exact client model)
 * 2. RLY logical tier              (`rly-tier:*`)
 * 3. client-native alias/model     (bare `haiku|sonnet|opus|fable`)
 * 4. subagent inherit/override     (`inherit` / parent-context freeze)
 * 5. profile/session policy        (`profile.modelRoles`, launch policy)
 * 6. env/settings ownership        (#126 typed env/settings ownership)
 * 7. persisted RLY-view state      (`claude-rly-*` persisted in the owning view)
 * 8. defaults
 */
export const PRECEDENCE_ORDER = [
  "exact-projection",
  "explicit-rly-tier",
  "client-native-alias",
  "exact-client-model",
  "subagent-inherit",
  "profile-policy",
  "env-settings-ownership",
  "persisted-rly-view",
  "default",
] as const;

export type PrecedenceSource = (typeof PRECEDENCE_ORDER)[number];

/** How the winning source actually resolved to the physical target. */
export type DecisionResolutionPath =
  | "projection-reverse-map"
  | "tier-resolver"
  | "client-alias-contract"
  | "profile-role-mapping"
  | "profile-default-role"
  | "parent-context"
  | "profile-default-fallback"
  | "persisted-view-state"
  | "env-ownership"
  | "default";

/**
 * A visible, deterministic conflict among decision inputs. Conflicts never
 * silently re-route: the request's explicit selection wins per the documented
 * precedence and the losing source is recorded here for diagnostics.
 */
export type ModelDecisionConflict = Readonly<{
  kind:
    /** Request selector differs from the owning view's persisted RLY projection model. */
    | "persisted-view-model-vs-request"
    /** Requested projection id is not the owning view's persisted model (foreign/stale). */
    | "projection-vs-view-state"
    /** Launch-policy pinned model differs from the request selector. */
    | "launch-policy-vs-request"
    /** Subagent explicitly selected a model different from the frozen parent context. */
    | "subagent-request-vs-parent-context"
    /** Gateway-contract env keys are present in the child environment (RLY-owned). */
    | "gateway-contract-env-present";
  /** Allowlisted detail (identifiers only, never settings content or secrets). */
  detail: string;
}>;

/** One stable, documented decision reason (code + allowlisted detail). */
export type ModelDecisionReason = Readonly<{
  code: string;
  detail: string;
}>;

/**
 * One blocked alternative from the #68 candidate assessment (allowlisted
 * metadata only). Produced from the selection trace's non-selected candidates
 * with a typed failure — never a second selector.
 */
export type ModelDecisionBlockedAlternative = Readonly<{
  logicalId: string;
  physicalModelId: string;
  modelFamily?: string;
  compatibilityState: CompatibilityState;
  blockedBy: readonly string[];
  /** #124: worst required-feature effective label when the ECR was the authority. */
  effectiveLabel?: string;
  enforcementReason?: string;
}>;

/** #124 ECR compatibility decision reference carried by the decision. */
export type ModelDecisionCompatibility = Readonly<{
  /** Which authority produced the compatibility answer. */
  authority: "ecr" | "seed";
  selectedLogicalId: string;
  /** #124: worst required-feature effective label (`trusted`/`stale`/`experimental`/...). */
  effectiveLabel?: EffectiveCompatibilityLabel;
  /** #124: distinct enforcement reason from the ECR (e.g. quarantine, override). */
  enforcementReason?: string;
  /** Static registry compatibility state (seed/reference only since #124). */
  seedState?: CompatibilityState;
  /** #124: effective answers for the required feature claims, keyed by feature. */
  features?: Readonly<Record<string, Readonly<{
    effective: EffectiveCompatibilityLabel;
    enforcement: EffectiveEnforcement;
  }>>>;
}>;

/**
 * The FINAL model-control output before account selection (#127).
 *
 * Produced once per supported RLY model-routing request, frozen before the
 * pool/account `RouteSelector` runs, and carried on the route decision trace
 * for diagnostics. Account/credential identity is NEVER part of this object.
 */
export type EffectiveModelDecision = Readonly<{
  schemaVersion: typeof MODEL_DECISION_SCHEMA_VERSION;
  requestId: string;
  profileId: string;
  profileName: string;
  /** Profile-scoped Claude view (#126) whose ownership state informed the decision. */
  viewId: string;
  /** #125: the typed selector intent that won precedence (kind/source/target only). */
  intent: ModelIntentTrace;
  /** Deterministic precedence bookkeeping (winner + visible conflicts). */
  precedence: Readonly<{
    /** The full documented precedence order applied, highest → lowest. */
    order: readonly PrecedenceSource[];
    /** Which source produced the effective selection. */
    winner: PrecedenceSource;
    /** How the winner resolved to the physical target. */
    resolvedThrough: DecisionResolutionPath;
    /** Visible, deterministic conflicts among the other sources (never silent). */
    conflicts: readonly ModelDecisionConflict[];
  }>;
  /** The frozen physical model target (before account selection). */
  target: Readonly<{
    accessProviderId: string;
    physicalModelId: string;
    logicalId: string;
    modelFamily?: string;
    adapterId: string;
  }>;
  /** Provenance of how the physical target was derived (#68/#69/#71/#72/#126). */
  provenance: Readonly<{
    projection?: ModelProjectionTrace;
    tier?: TierResolutionTrace;
    clientAlias?: Readonly<{ alias: ClientNativeAlias; mappedTier: LogicalTier }>;
    exactClientModel?: boolean;
    inherit?: Readonly<{ parentModelId: string; parentModelFamily?: string; contextSource: ParentContextSource }>;
    profileRole?: string;
    launchPolicyModel?: string;
    persistedViewModel?: string;
    environmentOwnership?: SettingsOwnershipSummary;
    defaulted: boolean;
  }>;
  /** #70: effective reasoning intent → native control mapping (metadata only). */
  reasoning: ResolvedReasoning;
  /** #124: Effective Compatibility Registry reference (authority result). */
  compatibility: ModelDecisionCompatibility;
  /** #72: provider → pool binding; account selection happens inside this pool. */
  poolBinding: Readonly<{
    poolId: string;
    providerId: string;
    policyRevision: number;
    policyHash: string;
    experimentalModels: boolean;
  }>;
  /** Revisions the decision was resolved under (policy/profile/session/registry). */
  revisions: Readonly<{
    policyRevision: number;
    policyHash: string;
    registryRevision?: number;
    mappingRevision?: number;
    sessionUniverseRevision: number;
  }>;
  /** Stable, documented decision reasons (actionable, secret-free). */
  reasons: readonly ModelDecisionReason[];
  /** Blocked alternatives with typed failure reasons (from #68 assessments). */
  blockedAlternatives: readonly ModelDecisionBlockedAlternative[];
  decidedAt: string;
}>;

/**
 * Structural #68 candidate assessment view consumed by the assembler
 * (secret-free; the same shape as `ModelCandidateAssessment`).
 */
export type ModelDecisionCandidate = Readonly<{
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
  authority?: "ecr" | "seed";
  effectiveLabel?: string;
  enforcementReason?: string;
  selected: boolean;
}>;

/**
 * Data-only input to the pure decision assembler. All stage outputs are
 * computed by the existing components (#68/#69/#70/#71/#72/#124/#125/#126);
 * the assembler only records them — it never re-resolves anything.
 */
export type EffectiveModelDecisionInput = Readonly<{
  requestId: string;
  profileId: string;
  profileName: string;
  viewId: string;
  intent: ModelIntentTrace;
  resolvedModelId: string;
  logicalId: string;
  accessProviderId: string;
  adapterId: string;
  modelFamily?: string;
  poolId: string;
  policyRevision: number;
  policyHash: string;
  registryRevision?: number;
  mappingRevision?: number;
  sessionUniverseRevision: number;
  experimentalModels: boolean;
  /** #70 result. */
  reasoning: ResolvedReasoning;
  /** #68 selection trace (includes candidate assessments + ECR authority). */
  selection: Readonly<{ source: "exact" | "candidates"; selectedLogicalId: string; reason: string; candidates: readonly ModelDecisionCandidate[] }>;
  tier?: TierResolutionTrace;
  projection?: ModelProjectionTrace;
  /** #125 client-native alias → mapped RLY tier (when the intent is an alias). */
  clientAlias?: Readonly<{ alias: ClientNativeAlias; mappedTier: LogicalTier }>;
  parent?: Readonly<{ parentModelId: string; parentModelFamily?: string; contextSource: ParentContextSource }>;
  profileRole?: string;
  launchPolicyModel?: string;
  persistedViewModel?: string;
  environmentOwnership?: SettingsOwnershipSummary;
  /** #124: per-feature effective answers for the selected model (optional). */
  effectiveFeatures?: Readonly<Record<string, Readonly<{ effective: EffectiveCompatibilityLabel; enforcement: EffectiveEnforcement }>>> | undefined;
  /** #69: #68 candidate assessments from the tier's derived/fallback evaluation. */
  tierAssessments?: readonly ModelDecisionCandidate[];
  decidedAt?: string;
}>;
