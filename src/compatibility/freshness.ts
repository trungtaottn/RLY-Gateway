import type { CompatibilityClaimDocument } from "../canary/claim.js";
import type { CompatibilityPolicy, ReviewDecision } from "./types.js";
import { latestDecision } from "./review.js";

/**
 * Freshness/staleness engine (#124).
 *
 * Defines freshness requirements by evidence kind/claim class and marks
 * evidence stale on configured identity/revision dependency changes:
 * client version/baseline drift, protocol/adapter revision drift, provider
 * endpoint/auth-mode drift, physical model fingerprint change, fixture/corpus
 * revision drift, material RLY build change, and evidence age.
 *
 * A stale positive can never remain silently VERIFIED: the effective resolver
 * downgrades a `stale` claim regardless of its reviewed decision.
 */

export type FreshnessResult = Readonly<{
  fresh: boolean;
  reason?: string;
}>;

/** Latest observation timestamp across the claim's evidence records. */
function latestCheckedAt(claim: CompatibilityClaimDocument): string | undefined {
  return claim.records.reduce<string | undefined>(
    (latest, record) => record.checkedAt > (latest ?? "") ? record.checkedAt : latest,
    undefined,
  );
}

/** Latest fixture revision across the claim's evidence records. */
function latestFixtureRevision(claim: CompatibilityClaimDocument): string | undefined {
  return claim.records.reduce<string | undefined>(
    (latest, record) => record.fixtureRevision > (latest ?? "") ? record.fixtureRevision : latest,
    undefined,
  );
}

/**
 * Deterministic freshness for one claim document + its decisions against a
 * policy. Returns `{ fresh: true }` only when no configured dependency drifted
 * and the evidence is within the allowed age window (when configured).
 */
export function freshnessFor(
  claim: CompatibilityClaimDocument,
  decisions: readonly ReviewDecision[],
  policy: CompatibilityPolicy,
  now: () => string = () => new Date().toISOString(),
): FreshnessResult {
  const identity = claim.claimIdentity;
  const checkedAt = latestCheckedAt(claim);
  // 1. Evidence age window (when configured).
  if (policy.maxEvidenceAgeMs !== undefined && checkedAt !== undefined) {
    const age = Date.parse(now()) - Date.parse(checkedAt);
    if (!Number.isNaN(age) && age > policy.maxEvidenceAgeMs) {
      return { fresh: false, reason: "evidence-age-exceeded" };
    }
  }
  // 2. Client version/baseline drift: claim keyed to another client version.
  if (policy.supportedClientBaseline !== undefined && identity.clientVersion !== policy.supportedClientBaseline) {
    return { fresh: false, reason: "client-version-drift" };
  }
  // 3. Protocol/adapter revision drift.
  if (policy.pinnedProtocolRevision !== undefined && identity.protocolRevision !== policy.pinnedProtocolRevision) {
    return { fresh: false, reason: "protocol-revision-drift" };
  }
  // 4. Provider endpoint/auth-mode/adapter drift (exact access path change).
  const accessConfig = policy.providerAccessConfig?.[identity.accessProviderId];
  if (accessConfig !== undefined) {
    if (identity.adapterId !== accessConfig.adapterId) return { fresh: false, reason: "adapter-drift" };
    if (identity.authMode !== accessConfig.authMode) return { fresh: false, reason: "auth-mode-drift" };
    if (identity.endpointContract !== accessConfig.endpointContract) return { fresh: false, reason: "endpoint-drift" };
    if (identity.sourceProtocol !== accessConfig.sourceProtocol) return { fresh: false, reason: "protocol-drift" };
  }
  // 5. Physical model fingerprint change: the reviewed target no longer exists.
  if (policy.deprecatedModelFingerprints?.includes(identity.physicalModelId) === true) {
    return { fresh: false, reason: "model-fingerprint-drift" };
  }
  // 6. Fixture/corpus revision drift.
  if (policy.pinnedFixtureRevision !== undefined && latestFixtureRevision(claim) !== policy.pinnedFixtureRevision) {
    return { fresh: false, reason: "fixture-revision-drift" };
  }
  // 7. Material RLY build change: a decision made under another build is stale.
  const decision = latestDecision(decisions);
  if (policy.rlyBuildVersion !== undefined && decision?.rlyBuildVersion !== undefined
    && decision.rlyBuildVersion !== policy.rlyBuildVersion) {
    return { fresh: false, reason: "rly-build-drift" };
  }
  return { fresh: true };
}
