import { describe, expect, it } from "vitest";
import { freshnessFor } from "../../src/compatibility/freshness.js";
import { claimIdentityFor, claimKeyFor } from "../../src/canary/claim.js";
import { CLAUDE_CODE_CONTRACT } from "../../src/canary/client-fixtures.js";
import { passedClaim, promoteDecision, pinnedPolicy } from "../helpers/compat.js";
import { defaultCompatibilityPolicy } from "../../src/compatibility/policy.js";

/**
 * Freshness/staleness engine (#124): marks evidence stale on configured
 * identity/revision dependency changes — client version/baseline, protocol/
 * adapter revision, provider endpoint/auth mode, model fingerprint, fixture/
 * corpus revision, material RLY build change, and evidence age. A stale
 * positive can never remain silently VERIFIED.
 */

function driftedIdentity(overrides: Partial<Parameters<typeof claimIdentityFor>[0]> = {}) {
  return claimIdentityFor({
    client: "claude-code",
    clientVersion: CLAUDE_CODE_CONTRACT.baseline,
    contract: CLAUDE_CODE_CONTRACT,
    adapterId: "codex-oauth",
    accessProviderId: "codex",
    physicalModelId: "gpt-5.4",
    ...overrides,
  });
}

describe("freshness/staleness engine (#124)", () => {
  it("stays fresh when every configured dependency matches", () => {
    const claim = passedClaim("text");
    expect(freshnessFor(claim, [], pinnedPolicy())).toEqual({ fresh: true });
  });

  it("marks stale on client version/baseline drift", () => {
    const claim = passedClaim("text", driftedIdentity({ clientVersion: "claude-code-2.1.231" }));
    expect(freshnessFor(claim, [], pinnedPolicy())).toEqual({ fresh: false, reason: "client-version-drift" });
  });

  it("marks stale on protocol revision drift", () => {
    const claim = passedClaim("text");
    const result = freshnessFor(claim, [], pinnedPolicy({ pinnedProtocolRevision: "claude-code-2.1.229-contract-v2" }));
    expect(result).toEqual({ fresh: false, reason: "protocol-revision-drift" });
  });

  it("marks stale on provider adapter/auth-mode/endpoint drift", () => {
    const claim = passedClaim("text");
    const result = freshnessFor(claim, [], pinnedPolicy({
      providerAccessConfig: Object.freeze({
        codex: Object.freeze({ adapterId: "codex-oauth", authMode: "direct-api-key", endpointContract: "anthropic-messages", sourceProtocol: "anthropic-messages" }),
      }),
    }));
    expect(result).toEqual({ fresh: false, reason: "auth-mode-drift" });
  });

  it("marks stale on deprecated physical model fingerprint change", () => {
    const claim = passedClaim("text");
    const result = freshnessFor(claim, [], pinnedPolicy({ deprecatedModelFingerprints: ["gpt-5.4"] }));
    expect(result).toEqual({ fresh: false, reason: "model-fingerprint-drift" });
  });

  it("marks stale on fixture/corpus revision drift", () => {
    const claim = passedClaim("text");
    const result = freshnessFor(claim, [], pinnedPolicy({ pinnedFixtureRevision: "claude-code-2.1.229-contract-v2" }));
    expect(result).toEqual({ fresh: false, reason: "fixture-revision-drift" });
  });

  it("marks stale on material RLY build change", () => {
    const claim = passedClaim("text");
    const decision = promoteDecision(claim);
    const result = freshnessFor(claim, [decision], pinnedPolicy({ rlyBuildVersion: "rly-newer-build" }));
    expect(result).toEqual({ fresh: false, reason: "rly-build-drift" });
  });

  it("marks stale when evidence exceeds the configured age window", () => {
    const claim = passedClaim("text");
    const result = freshnessFor(claim, [], pinnedPolicy({ maxEvidenceAgeMs: 1000 }), () => "1970-01-02T00:00:00.000Z");
    expect(result).toEqual({ fresh: false, reason: "evidence-age-exceeded" });
  });

  it("keeps evidence fresh within the age window", () => {
    const claim = passedClaim("text");
    const result = freshnessFor(claim, [], pinnedPolicy({ maxEvidenceAgeMs: 1000 }), () => "1970-01-01T00:00:00.500Z");
    expect(result).toEqual({ fresh: true });
  });

  it("returns fresh when no drift signals are configured (no fabricated staleness)", () => {
    const claim = passedClaim("text");
    expect(freshnessFor(claim, [], defaultCompatibilityPolicy())).toEqual({ fresh: true });
  });

  it("keys claim identity exactly so version drift is detected per exact path", () => {
    const drifted = claimKeyFor(driftedIdentity({ clientVersion: "claude-code-9.9.9" }), "text");
    const baseline = claimKeyFor(driftedIdentity(), "text");
    expect(drifted).not.toBe(baseline);
  });
});
