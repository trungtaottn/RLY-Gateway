import { describe, expect, it } from "vitest";
import { resolveEffectiveCompatibility, enforceEffective } from "../../src/compatibility/effective.js";
import { evidenceRevisionFor } from "../../src/compatibility/features.js";
import { passedClaim, failedClaim, promoteDecision, quarantineRecord, pinnedPolicy, keyFor } from "../helpers/compat.js";

/**
 * Effective Compatibility Registry — pure resolution (#124).
 *
 * Four orthogonal concepts (observed evidence, reviewed trust decision,
 * health/freshness, enforcement) resolve into ONE effective answer per exact
 * claim/feature with trust/health/freshness/quarantine/enforcement kept as
 * distinct diagnosable fields — never a single persisted boolean.
 */

describe("ECR pure resolution (#124)", () => {
  it("never lets PASS evidence alone produce reviewed trust", () => {
    const claim = passedClaim("text");
    const result = resolveEffectiveCompatibility({
      claimKey: claim.claimKey,
      feature: "text",
      claim,
      decisions: [],
      quarantines: [],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: false,
      allowQuarantineBypass: false,
    });
    expect(result.effective).toBe("experimental");
    expect(result.trust).toBe("none");
    expect(result.health).toBe("healthy");
    expect(result.freshness).toBe("fresh");
    expect(result.quarantine).toBe("none");
    expect(result.enforcement).toBe("blocked");
    expect(result.enforcementReason).toBe("unreviewed-experimental");
    // Distinct dimensions, never one boolean.
    expect(typeof result.trust).toBe("string");
    expect(typeof result.health).toBe("string");
    expect(typeof result.freshness).toBe("string");
    expect(result.layers).toEqual({ A: "passed", B: "passed", C: "passed" });
  });

  it("promotes to trusted only through an explicit decision covering the exact evidence revision", () => {
    const claim = passedClaim("text");
    const decision = promoteDecision(claim);
    const result = resolveEffectiveCompatibility({
      claimKey: claim.claimKey,
      feature: "text",
      claim,
      decisions: [decision],
      quarantines: [],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: false,
      allowQuarantineBypass: false,
    });
    expect(result.effective).toBe("trusted");
    expect(result.trust).toBe("reviewed");
    expect(result.enforcement).toBe("allowed");
    expect(result.decision?.decision).toBe("promote");
    expect(result.decision?.reviewer).toBe("owner");
  });

  it("marks the decision stale when evidence is updated after promotion (no auto-promotion)", async () => {
    const original = passedClaim("text");
    const decision = promoteDecision(original);
    // A genuinely new observation (different timestamp) appends.
    const { appendObservation } = await import("../../src/canary/claim.js");
    const base = original.records[0];
    if (base === undefined) throw new Error("missing record");
    const updated = appendObservation(original, Object.freeze({ ...base, checkedAt: "1970-01-03T00:00:00.000Z" }));
    const result = resolveEffectiveCompatibility({
      claimKey: updated.claimKey,
      feature: "text",
      claim: updated,
      decisions: [decision],
      quarantines: [],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: false,
      allowQuarantineBypass: false,
    });
    expect(result.effective).toBe("untrusted");
    expect(result.trust).toBe("review-stale");
    expect(result.trustReason).toBe("evidence-updated-after-review");
    expect(result.enforcement).toBe("blocked");
    // Even an explicit override cannot elevate an untrusted review-stale claim.
    const override = resolveEffectiveCompatibility({
      claimKey: updated.claimKey,
      feature: "text",
      claim: updated,
      decisions: [decision],
      quarantines: [],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: true,
      allowQuarantineBypass: false,
    });
    expect(override.enforcement).toBe("blocked");
    expect(override.enforcementReason).toBe("untrusted-required-feature");
  });

  it("keeps trust after an identical re-observation (dedupe preserves the revision)", async () => {
    const original = passedClaim("text");
    const decision = promoteDecision(original);
    // appendObservation dedupes identical records → same evidence revision, so
    // the decision's coverage survives a re-run of the same observation.
    const { appendObservation } = await import("../../src/canary/claim.js");
    const first = original.records[0];
    if (first === undefined) throw new Error("missing record");
    const same = appendObservation(original, first);
    expect(evidenceRevisionFor(same)).toBe(evidenceRevisionFor(original));
    const result = resolveEffectiveCompatibility({
      claimKey: original.claimKey,
      feature: "text",
      claim: same,
      decisions: [decision],
      quarantines: [],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: false,
      allowQuarantineBypass: false,
    });
    expect(result.effective).toBe("trusted");
  });

  it("gives quarantine precedence over any decision and fails closed", () => {
    const claim = passedClaim("text");
    const decision = promoteDecision(claim);
    const quarantine = quarantineRecord(claim.claimKey, "text");
    const result = resolveEffectiveCompatibility({
      claimKey: claim.claimKey,
      feature: "text",
      claim,
      decisions: [decision],
      quarantines: [quarantine],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: true,
      allowQuarantineBypass: false,
    });
    expect(result.effective).toBe("quarantined");
    expect(result.quarantine).toBe("active");
    expect(result.quarantineReason).toBe("strong-reproducible-failure");
    expect(result.enforcement).toBe("blocked");
    expect(result.enforcementReason).toBe("quarantined-fail-closed");
    // The experimental override cannot bypass a hard quarantine.
    expect(result.decision?.decision).toBe("promote"); // trust metadata preserved
  });

  it("permits quarantine bypass only through the separately documented administrative policy, visibly", () => {
    const claim = passedClaim("text");
    const quarantine = quarantineRecord(claim.claimKey, "text");
    const result = resolveEffectiveCompatibility({
      claimKey: claim.claimKey,
      feature: "text",
      claim,
      decisions: [],
      quarantines: [quarantine],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: false,
      allowQuarantineBypass: true,
    });
    expect(result.effective).toBe("quarantined");
    expect(result.enforcement).toBe("quarantine-bypass");
    expect(result.enforcementReason).toBe("admin-quarantine-bypass");
  });

  it("marks a promoted-but-stale claim stale — a stale positive never stays VERIFIED", () => {
    const claim = passedClaim("text");
    const decision = promoteDecision(claim);
    const result = resolveEffectiveCompatibility({
      claimKey: claim.claimKey,
      feature: "text",
      claim,
      decisions: [decision],
      quarantines: [],
      policy: pinnedPolicy({ rlyBuildVersion: "rly-newer-build" }),
      required: true,
      experimentalOverride: false,
      allowQuarantineBypass: false,
    });
    expect(result.effective).toBe("stale");
    expect(result.trust).toBe("reviewed");
    expect(result.freshness).toBe("stale");
    expect(result.freshnessReason).toBe("rly-build-drift");
    expect(result.enforcement).toBe("blocked");
    expect(result.enforcementReason).toBe("stale-positive-not-trusted");
  });

  it("allows an explicit experimental override for evidence-backed experimental/stale but never untrusted/missing", () => {
    const claim = passedClaim("text");
    const experimental = resolveEffectiveCompatibility({
      claimKey: claim.claimKey,
      feature: "text",
      claim,
      decisions: [],
      quarantines: [],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: true,
      allowQuarantineBypass: false,
    });
    expect(experimental.enforcement).toBe("experimental-override");
    expect(experimental.enforcementReason).toBe("explicit-experimental-override");

    const missing = resolveEffectiveCompatibility({
      claimKey: keyFor("text"),
      feature: "text",
      decisions: [],
      quarantines: [],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: true,
      allowQuarantineBypass: false,
    });
    expect(missing.effective).toBe("missing");
    expect(missing.enforcement).toBe("blocked");
    expect(missing.enforcementReason).toBe("missing-evidence-fail-closed");
  });

  it("treats failed evidence as untrusted with failed health", () => {
    const claim = failedClaim("text");
    const result = resolveEffectiveCompatibility({
      claimKey: claim.claimKey,
      feature: "text",
      claim,
      decisions: [],
      quarantines: [],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: true,
      allowQuarantineBypass: false,
    });
    expect(result.effective).toBe("untrusted");
    expect(result.health).toBe("failed");
    expect(result.enforcement).toBe("blocked");
  });

  it("treats an explicit reject decision as untrusted even with healthy evidence", () => {
    const claim = passedClaim("text");
    const decision = promoteDecision(claim, { decision: "reject", reason: "review-rejected" });
    const result = resolveEffectiveCompatibility({
      claimKey: claim.claimKey,
      feature: "text",
      claim,
      decisions: [decision],
      quarantines: [],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: true,
      allowQuarantineBypass: false,
    });
    expect(result.effective).toBe("untrusted");
    expect(result.trust).toBe("rejected");
    expect(result.enforcement).toBe("blocked");
  });

  it("does not gate features that are not required (feature-scoped enforcement)", () => {
    const claim = passedClaim("reasoning");
    const result = resolveEffectiveCompatibility({
      claimKey: claim.claimKey,
      feature: "reasoning",
      claim,
      decisions: [],
      quarantines: [],
      policy: pinnedPolicy(),
      required: false,
      experimentalOverride: false,
      allowQuarantineBypass: false,
    });
    expect(result.effective).toBe("experimental");
    expect(result.enforcement).toBe("allowed");
  });

  it("enforceEffective is context-correct for every label", () => {
    expect(enforceEffective("trusted", { required: true, experimentalOverride: false, allowQuarantineBypass: false }).enforcement).toBe("allowed");
    expect(enforceEffective("quarantined", { required: true, experimentalOverride: false, allowQuarantineBypass: false }).enforcement).toBe("blocked");
    expect(enforceEffective("quarantined", { required: true, experimentalOverride: false, allowQuarantineBypass: true }).enforcement).toBe("quarantine-bypass");
    expect(enforceEffective("experimental", { required: true, experimentalOverride: false, allowQuarantineBypass: false }).enforcement).toBe("blocked");
    expect(enforceEffective("experimental", { required: true, experimentalOverride: true, allowQuarantineBypass: false }).enforcement).toBe("experimental-override");
    expect(enforceEffective("stale", { required: true, experimentalOverride: true, allowQuarantineBypass: false }).enforcement).toBe("experimental-override");
    expect(enforceEffective("untrusted", { required: true, experimentalOverride: true, allowQuarantineBypass: false }).enforcement).toBe("blocked");
    expect(enforceEffective("missing", { required: true, experimentalOverride: true, allowQuarantineBypass: false }).enforcement).toBe("blocked");
    expect(enforceEffective("experimental", { required: false, experimentalOverride: false, allowQuarantineBypass: false }).enforcement).toBe("allowed");
  });
});
