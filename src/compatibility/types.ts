import type { EvidenceLayer } from "../canary/types.js";
import type { ClaimFeature, CompatibilityClaimDocument } from "../canary/claim.js";
import type { AuthMode, EndpointContract, ClaimSourceProtocol } from "../canary/types.js";

/**
 * Wave 2 Track 3 Effective Compatibility Registry (#124).
 *
 * Four orthogonal concepts are resolved into ONE effective answer per exact
 * claim/feature, and are NEVER collapsed into a single persisted boolean:
 *   1. observed evidence  — #122 Compatibility Claim + Evidence v2 documents
 *      (#123 Layer B/C runner records appended through `ClaimEvidenceStore`);
 *   2. reviewed trust     — explicit Review Decisions tied to exact claim
 *      identities + evidence revisions (PASS alone never auto-promotes);
 *   3. health/freshness   — staleness over client baseline, protocol/adapter
 *      revision, provider endpoint/auth mode, model fingerprint, fixture
 *      revision, and material RLY build changes;
 *   4. enforcement        — policy gating (required features fail closed;
 *      explicit traceable experimental override; hard quarantine cannot be
 *      bypassed unless a separately documented administrative policy exists).
 *
 * Privacy: decision/quarantine records carry reviewer/source/reason/timestamp/
 * revision metadata ONLY — never credentials, account identity, prompts,
 * responses, or reasoning text.
 */

/** Explicit reviewed trust decision for one exact claim/feature (#124). */
export type ReviewDecisionKind = "promote" | "reject";

/**
 * One durable review decision. `evidenceRevision` is a deterministic digest of
 * the exact evidence snapshot the decision was made against (see
 * `evidenceRevisionFor`): a new observation invalidates the decision's
 * coverage and the claim must be re-reviewed — evidence update never
 * auto-promotes and never silently keeps old trust.
 */
export type ReviewDecision = Readonly<{
  claimKey: string;
  feature: ClaimFeature;
  decision: ReviewDecisionKind;
  /** Digest of the claim evidence snapshot the decision was based on. */
  evidenceRevision: string;
  /** Reviewer identity metadata only (e.g. `owner`, `wave-2-review`). */
  reviewer: string;
  /** Provenance source (e.g. `cli-compat-review`, `control-plane-admin`). */
  source: string;
  /** Typed reason, never user content (e.g. `layers-a-b-c-pass-review`). */
  reason: string;
  decidedAt: string;
  /** Monotonic per (claimKey, feature) decision revision (1, 2, 3, ...). */
  decisionRevision: number;
  /** RLY build under which the review was made (freshness dependency). */
  rlyBuildVersion?: string;
}>;

/**
 * One durable negative-quarantine record for an EXACT claim/path/feature.
 * Scope is inherently narrow: the record is keyed to the exact claim key, so
 * one provider/model/feature failure can never poison unrelated paths or
 * features. Quarantine never deletes historical evidence — it only makes the
 * exact claim fail closed at the effective/enforcement layer.
 */
export type QuarantineRecord = Readonly<{
  claimKey: string;
  feature: ClaimFeature;
  /** Typed reason, e.g. `strong-reproducible-failure` + failure category. */
  reason: string;
  /** Provenance source (e.g. `runner-fail-fast`, `cli-compat-quarantine`). */
  source: string;
  quarantinedAt: string;
  /** Monotonic per (claimKey, feature) quarantine revision (1, 2, 3, ...). */
  quarantineRevision: number;
  /** RLY build under which the quarantine was recorded (freshness input). */
  rlyBuildVersion?: string;
  /** Set when the quarantine is explicitly lifted (audit-friendly). */
  liftedAt?: string;
  liftedBy?: string;
  liftReason?: string;
}>;

/** Trust dimension of the effective result (reviewed authority). */
export type EffectiveTrust = "reviewed" | "none" | "rejected" | "review-stale";

/** Health dimension from the evidence history (observed behavior). */
export type EffectiveHealth = "healthy" | "degraded" | "failed" | "unknown";

/** Freshness dimension (staleness engine). `unknown` = no evidence to age. */
export type EffectiveFreshness = "fresh" | "stale" | "unknown";

/** Quarantine dimension. */
export type EffectiveQuarantine = "none" | "active";

/** Enforcement dimension (policy gate for the requesting context). */
export type EffectiveEnforcement = "allowed" | "blocked" | "experimental-override" | "quarantine-bypass";

/**
 * Summary label for consumers. Never a persisted boolean — the dimensions
 * below stay separately diagnosable.
 * - `trusted`      — reviewed promotion + fresh + healthy evidence + no quarantine.
 * - `stale`        — reviewed promotion existed but freshness/staleness now says
 *                    stale; a stale positive never stays silently VERIFIED.
 * - `experimental` — evidence exists (not failed) but no reviewed promotion.
 * - `untrusted`    — evidence failed, explicitly rejected, or the decision no
 *                    longer covers the current evidence revision.
 * - `quarantined`  — hard negative quarantine active for the exact claim.
 * - `missing`      — no claim/evidence at all.
 */
export type EffectiveCompatibilityLabel =
  | "trusted"
  | "stale"
  | "experimental"
  | "untrusted"
  | "quarantined"
  | "missing";

/** One effective answer per exact claim/feature (never a single boolean). */
export type EffectiveCompatibility = Readonly<{
  claimKey: string;
  feature: ClaimFeature;
  /** Summary label (derived from the dimensions below). */
  effective: EffectiveCompatibilityLabel;
  /** Trust dimension: reviewed decision state. */
  trust: EffectiveTrust;
  /** Health dimension: latest evidence state. */
  health: EffectiveHealth;
  /** Freshness dimension. */
  freshness: EffectiveFreshness;
  /** Quarantine dimension. */
  quarantine: EffectiveQuarantine;
  /** Enforcement dimension for this context (required/override/bypass). */
  enforcement: EffectiveEnforcement;
  /** Per-layer evidence status (A/B/C), explicit per claim. */
  layers: Readonly<Record<EvidenceLayer, "missing" | "not-run" | "passed" | "failed">>;
  /** Latest decision metadata (reviewer/source/decidedAt/revision only). */
  decision?: Readonly<{
    decision: ReviewDecisionKind;
    decisionRevision: number;
    reviewer: string;
    source: string;
    decidedAt: string;
  }>;
  /** Active quarantine metadata (source/date/revision only). */
  quarantineRecord?: Readonly<{ source: string; quarantinedAt: string; quarantineRevision: number }>;
  /** Distinct, human-diagnosable reasons for each dimension. */
  trustReason?: string;
  healthReason?: string;
  freshnessReason?: string;
  quarantineReason?: string;
  enforcementReason?: string;
}>;

/**
 * Freshness/staleness + enforcement policy (#124). All fields optional so a
 * minimal policy fails safe (a missing pinned dependency defaults to
 * "no drift signal", never to fabricated staleness).
 */
export type CompatibilityPolicy = Readonly<{
  /** Current supported client baseline; claim keyed to another version is stale. */
  supportedClientBaseline?: string;
  /** Currently pinned client-contract/protocol revision; claim/evidence drift is stale. */
  pinnedProtocolRevision?: string;
  /** Currently pinned fixture/corpus revision; evidence from another corpus is stale. */
  pinnedFixtureRevision?: string;
  /** Evidence older than this window is stale (ISO duration in ms). */
  maxEvidenceAgeMs?: number;
  /** Material RLY build; a decision made under another build is stale. */
  rlyBuildVersion?: string;
  /** Physical model fingerprints no longer the reviewed target (deprecated ids). */
  deprecatedModelFingerprints?: readonly string[];
  /** Current adapter/auth/endpoint surface per access provider. */
  providerAccessConfig?: Readonly<Record<string, Readonly<{
    adapterId: string;
    authMode: AuthMode;
    endpointContract: EndpointContract;
    sourceProtocol: ClaimSourceProtocol;
  }>>>;
  /**
   * Seed/reference mapping policy for legacy static registry compatibility
   * states (#124 audit/migration): pre-v2 reviewed states are reference data
   * that can never silently equal a reviewed v2 decision. When true, a static
   * registry `state` may only influence the seed-level fallback derivation
   * (never reviewed trust).
   */
  legacySeedPolicy: "seed-reference-only";
  /**
   * Separately documented ADMINISTRATIVE policy that permits bypassing a hard
   * quarantine. Default false; even when true the bypass is visible in the
   * enforcement field/reason and in doctor/status. Never implicitly enabled.
   */
  allowQuarantineBypass?: boolean;
}>;

/** Everything the pure effective resolver needs for one claim/feature. */
export type EffectiveResolutionInput = Readonly<{
  /** Exact claim key being resolved (present even when no claim doc exists). */
  claimKey: string;
  /** Feature being resolved (present even when no claim doc exists). */
  feature: ClaimFeature;
  claim?: CompatibilityClaimDocument;
  decisions: readonly ReviewDecision[];
  quarantines: readonly QuarantineRecord[];
  policy: CompatibilityPolicy;
  /** True when this feature is required for the requesting context. */
  required: boolean;
  /** Explicit traceable experimental override for this context. */
  experimentalOverride: boolean;
  /** Separately documented administrative policy; defaults to false. */
  allowQuarantineBypass: boolean;
  now?: () => string;
}>;
