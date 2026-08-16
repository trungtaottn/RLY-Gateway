import { layerStatuses, claimStatusFor, type ClaimStatus } from "../canary/claim.js";
import { freshnessFor } from "./freshness.js";
import { latestQuarantine, isQuarantined } from "./quarantine.js";
import { decisionCovers, latestDecision } from "./review.js";
import { evidenceRevisionFor } from "./features.js";
import type {
  EffectiveCompatibility,
  EffectiveCompatibilityLabel,
  EffectiveFreshness,
  EffectiveHealth,
  EffectiveResolutionInput,
  EffectiveTrust,
} from "./types.js";

/**
 * Effective Compatibility Registry — pure resolution (#124).
 *
 * Resolves evidence + review decision + quarantine + freshness + policy into
 * ONE effective answer per exact claim/feature, keeping trust, observed
 * health, freshness, quarantine, and enforcement reason separately
 * diagnosable — never a single persisted boolean.
 *
 * Precedence (deterministic, documented):
 *   1. Active quarantine for the exact claim ⇒ `quarantined` (hard negative).
 *   2. Missing claim/evidence ⇒ `missing` (fail closed, never trusted).
 *   3. Any failed observation ⇒ `untrusted` (health failed).
 *   4. Latest review decision (by decision revision):
 *        - `reject` ⇒ `untrusted` (trust=rejected).
 *        - `promote` that no longer covers the current evidence revision ⇒
 *          `untrusted` (trust=review-stale; evidence updated without
 *          promotion ⇒ re-review required).
 *        - `promote` covering current evidence + claim not passed ⇒
 *          `untrusted` (decision contradicted by evidence).
 *        - `promote` covering current evidence + fresh + claim passed ⇒
 *          `trusted`.
 *        - `promote` covering current evidence but STALE ⇒ `stale` (a stale
 *          positive never stays silently VERIFIED).
 *   5. No decision: passed claim ⇒ `experimental` (unreviewed PASS); partial/
 *      missing required layers ⇒ `untrusted` (health degraded/unknown).
 *
 * Enforcement (separate dimension): required features fail closed unless
 * effective trust; explicit experimental override may elevate
 * `experimental`/`stale` (evidence-backed) but NEVER `untrusted`/`missing`/
 * `quarantined`; a hard quarantine cannot be bypassed unless the separately
 * documented administrative policy (`allowQuarantineBypass`) is set, and the
 * bypass remains visible in the enforcement field + reason.
 */

function healthFromStatus(status: ClaimStatus, hasAnyEvidence: boolean): { health: EffectiveHealth; reason?: string } {
  if (!hasAnyEvidence) return { health: "unknown" };
  switch (status) {
    case "passed": return { health: "healthy" };
    case "failed": return { health: "failed", reason: "failed-observation" };
    case "not-run": return { health: "degraded", reason: "required-layer-missing" };
    case "missing": return { health: "unknown" };
  }
}

/** Summary label for one resolution (documented precedence in module doc). */
function labelFor(input: EffectiveResolutionInput): EffectiveCompatibilityLabel {
  if (isQuarantined(input.quarantines)) return "quarantined";
  if (input.claim === undefined) return "missing";
  const status = claimStatusFor(input.claim);
  const decision = latestDecision(input.decisions);
  if (status === "failed") return "untrusted";
  if (decision !== undefined) {
    if (decision.decision === "reject") return "untrusted";
    if (!decisionCovers(decision, evidenceRevisionFor(input.claim))) return "untrusted";
    if (status !== "passed") return "untrusted";
    const freshness = freshnessFor(input.claim, input.decisions, input.policy, input.now ?? (() => new Date().toISOString()));
    if (!freshness.fresh) return "stale";
    return "trusted";
  }
  // No reviewed decision: an unreviewed PASS is EXPERIMENTAL at most; partial
  // or missing evidence is untrusted.
  return status === "passed" ? "experimental" : "untrusted";
}

/**
 * Resolves ONE effective answer for one exact claim/feature. Pure and
 * deterministic for identical inputs.
 */
export function resolveEffectiveCompatibility(input: EffectiveResolutionInput): EffectiveCompatibility {
  const now = input.now ?? (() => new Date().toISOString());
  const claim = input.claim;
  const claimKey = input.claimKey;
  const feature = input.feature;
  const status = claim === undefined ? "missing" : claimStatusFor(claim);
  const quarantine = latestQuarantine(input.quarantines);
  const decision = latestDecision(input.decisions);
  const layers = claim === undefined
    ? Object.freeze({ A: "missing", B: "missing", C: "missing" })
    : layerStatuses(claim);
  const evidenceRevisionOf = claim === undefined ? undefined : evidenceRevisionFor(claim);

  // Freshness (only meaningful with evidence).
  const freshness: EffectiveFreshness = claim === undefined
    ? "unknown"
    : freshnessFor(claim, input.decisions, input.policy, now).fresh ? "fresh" : "stale";
  const freshnessReason = claim === undefined
    ? undefined
    : freshnessFor(claim, input.decisions, input.policy, now).fresh ? undefined : freshnessFor(claim, input.decisions, input.policy, now).reason;

  // Trust dimension.
  let trust: EffectiveTrust = "none";
  let trustReason: string | undefined;
  if (decision !== undefined) {
    if (decision.decision === "reject") {
      trust = "rejected";
      trustReason = "explicit-rejection";
    } else if (!decisionCovers(decision, evidenceRevisionOf ?? "")) {
      trust = "review-stale";
      trustReason = "evidence-updated-after-review";
    } else if (status !== "passed") {
      trust = "review-stale";
      trustReason = "decision-contradicted-by-evidence";
    } else {
      trust = "reviewed";
    }
  }

  // Health dimension.
  const health = healthFromStatus(status, claim !== undefined && claim.records.length > 0);

  const label = labelFor(input);

  // Enforcement dimension.
  let enforcement: EffectiveCompatibility["enforcement"] = "allowed";
  let enforcementReason: string | undefined;
  if (input.required) {
    if (label === "trusted") {
      enforcement = "allowed";
    } else if (label === "quarantined") {
      if (input.allowQuarantineBypass === true) {
        enforcement = "quarantine-bypass";
        enforcementReason = "admin-quarantine-bypass";
      } else {
        enforcement = "blocked";
        enforcementReason = "quarantined-fail-closed";
      }
    } else if (label === "experimental" || label === "stale") {
      if (input.experimentalOverride === true) {
        enforcement = "experimental-override";
        enforcementReason = "explicit-experimental-override";
      } else {
        enforcement = "blocked";
        enforcementReason = label === "stale" ? "stale-positive-not-trusted" : "unreviewed-experimental";
      }
    } else {
      // untrusted / missing: never bypassable by the experimental override.
      enforcement = "blocked";
      enforcementReason = label === "missing" ? "missing-evidence-fail-closed" : "untrusted-required-feature";
    }
  }

  return Object.freeze({
    claimKey,
    feature,
    effective: label,
    trust,
    health: health.health,
    ...(health.reason === undefined ? {} : { healthReason: health.reason }),
    freshness,
    ...(freshnessReason === undefined ? {} : { freshnessReason }),
    quarantine: quarantine === undefined ? "none" : "active",
    ...(quarantine === undefined
      ? {}
      : {
          quarantineRecord: Object.freeze({
            source: quarantine.source,
            quarantinedAt: quarantine.quarantinedAt,
            quarantineRevision: quarantine.quarantineRevision,
          }),
          quarantineReason: quarantine.reason,
        }),
    enforcement,
    ...(enforcementReason === undefined ? {} : { enforcementReason }),
    layers,
    ...(decision === undefined
      ? {}
      : {
          decision: Object.freeze({
            decision: decision.decision,
            decisionRevision: decision.decisionRevision,
            reviewer: decision.reviewer,
            source: decision.source,
            decidedAt: decision.decidedAt,
          }),
        }),
    ...(trustReason === undefined ? {} : { trustReason }),
  });
}
