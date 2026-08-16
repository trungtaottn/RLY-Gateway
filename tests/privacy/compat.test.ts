import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaimEvidenceStore } from "../../src/canary/artifact.js";
import { assertSecretFree } from "../../src/control-plane/secret-free.js";
import { EffectiveCompatibilityRegistry } from "../../src/compatibility/registry.js";
import { ReviewDecisionStore, QuarantineStore } from "../../src/compatibility/stores.js";
import { runtimeCompatibilityPolicy } from "../../src/compatibility/policy.js";
import { CLAUDE_CODE_CONTRACT } from "../../src/canary/client-fixtures.js";
import { evidenceRevisionFor } from "../../src/compatibility/features.js";
import { passedClaim } from "../helpers/compat.js";

/**
 * Effective Compatibility Registry privacy (#124): decision/quarantine records
 * and effective explanations carry reviewer/source/reason/timestamp/revision
 * metadata only — never credentials, auth headers, account identity, prompts,
 * responses, or reasoning text.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-compat-privacy-"));
  directories.push(directory);
  return directory;
}

describe("ECR privacy (#124)", () => {
  it("keeps review decisions secret-free with restrictive private modes", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const reviews = new ReviewDecisionStore(controlPlane);
    const claim = passedClaim("text");
    const result = await reviews.addDecision({
      claimKey: claim.claimKey,
      feature: "text",
      decision: "promote",
      evidenceRevision: evidenceRevisionFor(claim),
      reviewer: "owner",
      source: "test",
      reason: "layers-a-b-c-pass-review",
      decidedAt: "1970-01-01T00:00:00.000Z",
      rlyBuildVersion: "rly-test-build",
    });
    assertSecretFree(result.decision);
    const serialized = JSON.stringify(await reviews.listDecisions());
    expect(serialized).not.toMatch(/"(accessToken|refreshToken|authorization|token|secret|password|email|prompt|response)"/);
    expect((await stat(join(controlPlane, "compat"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(controlPlane, "compat", "reviews"))).mode & 0o777).toBe(0o700);
  });

  it("keeps quarantine records secret-free", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const quarantines = new QuarantineStore(controlPlane);
    const claim = passedClaim("text");
    const result = await quarantines.quarantine({
      claimKey: claim.claimKey,
      feature: "text",
      reason: "strong-reproducible-failure",
      source: "runner-fail-fast",
      quarantinedAt: "1970-01-01T00:00:00.000Z",
    });
    assertSecretFree(result.record);
    const serialized = JSON.stringify(await quarantines.listRecords());
    expect(serialized).not.toMatch(/"(accessToken|refreshToken|authorization|token|secret|password|email|prompt|response)"/);
    expect((await stat(join(controlPlane, "compat", "quarantines"))).mode & 0o777).toBe(0o700);
  });

  it("produces secret-free effective answers and explanations", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const claimStore = new ClaimEvidenceStore(controlPlane);
    const reviews = new ReviewDecisionStore(controlPlane);
    const quarantines = new QuarantineStore(controlPlane);
    const claim = passedClaim("text");
    await claimStore.writeClaim(claim);
    await reviews.addDecision({
      claimKey: claim.claimKey,
      feature: "text",
      decision: "promote",
      evidenceRevision: evidenceRevisionFor(claim),
      reviewer: "owner",
      source: "test",
      reason: "layers-a-b-c-pass-review",
      decidedAt: "1970-01-02T00:00:00.000Z",
      rlyBuildVersion: "rly-test-build",
    });
    await quarantines.quarantine({
      claimKey: claim.claimKey,
      feature: "text",
      reason: "strong-reproducible-failure",
      source: "runner-fail-fast",
      quarantinedAt: "1970-01-03T00:00:00.000Z",
    });
    const registry = new EffectiveCompatibilityRegistry({
      claims: claimStore,
      reviews,
      quarantines,
      policy: runtimeCompatibilityPolicy({
        supportedClientBaseline: CLAUDE_CODE_CONTRACT.baseline,
        pinnedProtocolRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
        pinnedFixtureRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
        rlyBuildVersion: "rly-test-build",
      }),
    });
    const effective = await registry.effectiveForClaimKey(claim.claimKey, "text", { required: true });
    assertSecretFree(effective);
    const serialized = JSON.stringify(effective);
    expect(serialized).toContain("quarantined");
    expect(serialized).toContain("strong-reproducible-failure");
    expect(serialized).not.toMatch(/"(accessToken|refreshToken|authorization|token|secret|password|email|prompt|response)"/);
  });
});
