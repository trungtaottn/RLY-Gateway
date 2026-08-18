import {
  appendObservation,
  claimIdentityFor,
  claimKeyFor,
  emptyClaimDocument,
  type CompatibilityClaimDocument,
  type CompatibilityClaimIdentity,
  type EvidenceArtifactV2,
  type ClaimFeature,
} from "../../src/canary/claim.js";
import { CLAUDE_CODE_CONTRACT } from "../../src/canary/client-fixtures.js";
import { evidenceRevisionFor } from "../../src/compatibility/features.js";
import { defaultCompatibilityPolicy } from "../../src/compatibility/policy.js";
import type { CompatibilityPolicy, QuarantineRecord, ReviewDecision } from "../../src/compatibility/types.js";

/**
 * Shared helpers for #124 Effective Compatibility Registry tests.
 * Deterministic fixtures only — never credentials, prompts, responses, or
 * account identity.
 */

export const IDENTITY: CompatibilityClaimIdentity = claimIdentityFor({
  client: "claude-code",
  clientVersion: CLAUDE_CODE_CONTRACT.baseline,
  contract: CLAUDE_CODE_CONTRACT,
  adapterId: "codex-oauth",
  accessProviderId: "codex",
  physicalModelId: "gpt-5.4",
  modelFamily: "openai/codex",
});

export function keyFor(feature: ClaimFeature): string {
  return claimKeyFor(IDENTITY, feature);
}

export function record(overrides: Partial<EvidenceArtifactV2> = {}): EvidenceArtifactV2 {
  return Object.freeze({
    claimKey: keyFor("text"),
    feature: "text",
    layer: "A",
    kind: "deterministic-fake-matrix",
    fixtureRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
    runnerVersion: "rly-canary-runner/2.0",
    checkedAt: "1970-01-01T00:00:00.000Z",
    result: "passed",
    environment: Object.freeze({ platform: "linux", nodeVersion: "v24.0.0" }),
    ...overrides,
  });
}

/** Claim with every required layer (A/B/C) passing for one feature. */
export function passedClaim(feature: ClaimFeature = "text", base: CompatibilityClaimIdentity = IDENTITY): CompatibilityClaimDocument {
  let doc = emptyClaimDocument(base, feature);
  for (const layer of ["A", "B", "C"] as const) {
    doc = appendObservation(doc, record({
      claimKey: claimKeyFor(base, feature),
      feature,
      layer,
      kind: layer === "A" ? "deterministic-fake-matrix" : layer === "B" ? "installed-client" : "live-access-path",
      runnerVersion: layer === "A" ? "rly-canary-runner/2.0" : "rly-canary-runner/2.1",
    }));
  }
  return doc;
}

/** Claim with a failing observation in the given layer. */
export function failedClaim(feature: ClaimFeature = "text", layer: "A" | "B" | "C" = "A"): CompatibilityClaimDocument {
  const doc = passedClaim(feature);
  return appendObservation(doc, record({
    claimKey: keyFor(feature),
    feature,
    layer,
    result: "failed",
    failureReason: "required-gate-failed",
  }));
}

/** A promote decision covering exactly the given claim's evidence revision. */
export function promoteDecision(
  claim: CompatibilityClaimDocument,
  overrides: Partial<ReviewDecision> = {},
): ReviewDecision {
  return Object.freeze({
    claimKey: claim.claimKey,
    feature: claim.feature,
    decision: "promote",
    evidenceRevision: evidenceRevisionFor(claim),
    reviewer: "owner",
    source: "test",
    reason: "layers-a-b-c-pass-review",
    decidedAt: "1970-01-02T00:00:00.000Z",
    decisionRevision: 1,
    rlyBuildVersion: "rly-test-build",
    ...overrides,
  });
}

export function quarantineRecord(
  claimKey: string,
  feature: ClaimFeature,
  overrides: Partial<QuarantineRecord> = {},
): QuarantineRecord {
  return Object.freeze({
    claimKey,
    feature,
    reason: "strong-reproducible-failure",
    source: "test",
    quarantinedAt: "1970-01-02T00:00:00.000Z",
    quarantineRevision: 1,
    rlyBuildVersion: "rly-test-build",
    ...overrides,
  });
}

/** Policy pinned to the fixture baseline/contract (fresh by default). */
export function pinnedPolicy(overrides: Partial<CompatibilityPolicy> = {}): CompatibilityPolicy {
  return Object.freeze({
    ...defaultCompatibilityPolicy(),
    supportedClientBaseline: CLAUDE_CODE_CONTRACT.baseline,
    pinnedProtocolRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
    pinnedFixtureRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
    rlyBuildVersion: "rly-test-build",
    ...overrides,
  });
}
