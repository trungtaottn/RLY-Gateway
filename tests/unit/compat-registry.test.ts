import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaimEvidenceStore } from "../../src/canary/artifact.js";
import { claimKeyFor } from "../../src/canary/claim.js";
import { CLAUDE_CODE_CONTRACT } from "../../src/canary/client-fixtures.js";
import { EffectiveCompatibilityRegistry } from "../../src/compatibility/registry.js";
import { ReviewDecisionStore, QuarantineStore } from "../../src/compatibility/stores.js";
import { runtimeCompatibilityPolicy } from "../../src/compatibility/policy.js";
import { evidenceRevisionFor } from "../../src/compatibility/features.js";
import { reviewedModel } from "../../src/registry/model-registry.js";
import { IDENTITY, passedClaim, promoteDecision } from "../helpers/compat.js";
import type { ProviderCapabilities } from "../../src/core/capabilities.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-compat-registry-"));
  directories.push(directory);
  return directory;
}

function capabilities(): ProviderCapabilities {
  return Object.freeze({
    streaming: true, tools: true, parallelTools: false, images: false, reasoning: true,
    redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate",
  });
}

/** A registry row matching the test claim identity (codex / gpt-5.4). */
function codexRow(overrides: Partial<Parameters<typeof reviewedModel>[0]> = {}): ReturnType<typeof reviewedModel> {
  return reviewedModel({
    accessProviderId: "codex",
    upstreamModelId: "gpt-5.4",
    modelFamily: "openai/codex",
    verifiedAt: "2026-08-21",
    fixtureVersion: "codex-oauth-chat-v1",
    capabilities: capabilities(),
    ...overrides,
  });
}

function registryFor(directory: string): EffectiveCompatibilityRegistry {
  return new EffectiveCompatibilityRegistry({
    claims: new ClaimEvidenceStore(directory),
    reviews: new ReviewDecisionStore(directory),
    quarantines: new QuarantineStore(directory),
    policy: runtimeCompatibilityPolicy({
      supportedClientBaseline: CLAUDE_CODE_CONTRACT.baseline,
      pinnedProtocolRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
      pinnedFixtureRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
      rlyBuildVersion: "rly-test-build",
    }),
  });
}

describe("EffectiveCompatibilityRegistry facade (#124)", () => {
  it("treats legacy static states as seed/reference data — never silently reviewed", async () => {
    const directory = await temporaryDirectory();
    const registryStore = registryFor(directory);
    // A static VERIFIED row with NO claim evidence: seed only, never trusted.
    const row = codexRow({ compatibility: { state: "VERIFIED", baseline: "claude-code-2.1.229", evidenceRef: "verify-1", checkedAt: "2026-08-21" } });
    const effective = await registryStore.effectiveForModel(row, ["text"], { required: true, experimentalOverride: false });
    const text = effective.get("text");
    expect(text?.effective).toBe("experimental");
    expect(text?.trust).toBe("none");
    expect(text?.enforcement).toBe("blocked");
    expect(text?.enforcementReason).toBe("seed-unreviewed-required-feature");
  });

  it("resolves a reviewed claim to trusted and preserves evidence update semantics", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const claimStore = new ClaimEvidenceStore(controlPlane);
    const reviews = new ReviewDecisionStore(controlPlane);
    const registryStore = registryFor(controlPlane);
    const claim = passedClaim("text");
    await claimStore.writeClaim(claim);
    const decision = promoteDecision(claim);
    await reviews.addDecision({
      claimKey: claim.claimKey,
      feature: "text",
      decision: "promote",
      evidenceRevision: decision.evidenceRevision,
      reviewer: "owner",
      source: "test",
      reason: "layers-a-b-c-pass-review",
      decidedAt: decision.decidedAt,
      rlyBuildVersion: "rly-test-build",
    });
    const effective = await registryStore.effectiveForModel(codexRow(), ["text"], { required: true });
    expect(effective.get("text")?.effective).toBe("trusted");
    expect(effective.get("text")?.decision?.reviewer).toBe("owner");
    // Evidence updated after promotion → re-review required.
    const { appendObservation } = await import("../../src/canary/claim.js");
    const base = claim.records[0];
    if (base === undefined) throw new Error("missing record");
    const updated = appendObservation(claim, Object.freeze({ ...base, checkedAt: "1970-01-09T00:00:00.000Z" }));
    await claimStore.writeClaim(updated);
    const after = await registryStore.effectiveForModel(codexRow(), ["text"], { required: true });
    expect(after.get("text")?.effective).toBe("untrusted");
    expect(after.get("text")?.trust).toBe("review-stale");
  });

  it("quarantines one exact path without poisoning another provider or feature", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const claimStore = new ClaimEvidenceStore(controlPlane);
    const reviews = new ReviewDecisionStore(controlPlane);
    const quarantines = new QuarantineStore(controlPlane);
    const registryStore = new EffectiveCompatibilityRegistry({
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
    const textClaim = passedClaim("text");
    const reasoningClaim = passedClaim("reasoning");
    await claimStore.writeClaim(textClaim);
    await claimStore.writeClaim(reasoningClaim);
    await reviews.addDecision({ claimKey: textClaim.claimKey, feature: "text", decision: "promote", evidenceRevision: evidenceRevisionFor(textClaim), reviewer: "owner", source: "test", reason: "reviewed", decidedAt: "1970-01-02T00:00:00.000Z", rlyBuildVersion: "rly-test-build" });
    await reviews.addDecision({ claimKey: reasoningClaim.claimKey, feature: "reasoning", decision: "promote", evidenceRevision: evidenceRevisionFor(reasoningClaim), reviewer: "owner", source: "test", reason: "reviewed", decidedAt: "1970-01-02T00:00:00.000Z", rlyBuildVersion: "rly-test-build" });
    // Quarantine ONLY the codex text claim.
    await quarantines.quarantine({ claimKey: textClaim.claimKey, feature: "text", reason: "strong-reproducible-failure", source: "runner-fail-fast", quarantinedAt: "1970-01-03T00:00:00.000Z" });
    const effective = await registryStore.effectiveForModel(codexRow(), ["text", "reasoning"], { required: true });
    expect(effective.get("text")?.effective).toBe("quarantined");
    expect(effective.get("text")?.enforcement).toBe("blocked");
    // The same-path reasoning feature is NOT quarantined (feature isolation).
    expect(effective.get("reasoning")?.effective).toBe("trusted");
    expect(effective.get("reasoning")?.enforcement).toBe("allowed");
    // Another provider's text claim is untouched (provider-path isolation).
    const otherProviderClaim = passedClaim("text", {
      ...IDENTITY,
      accessProviderId: "cline",
      adapterId: "cline-interop",
      authMode: "interop-import",
      physicalModelId: "claude-sonnet-4-5",
    });
    expect(claimKeyFor(otherProviderClaim.claimIdentity, "text")).not.toBe(textClaim.claimKey);
    const clineRow = reviewedModel({
      accessProviderId: "cline", upstreamModelId: "claude-sonnet-4-5", modelFamily: "anthropic",
      verifiedAt: "2026-08-21", fixtureVersion: "cline-interop-chat-v1", capabilities: capabilities(),
    });
    await claimStore.writeClaim(otherProviderClaim);
    const clineEffective = await registryStore.effectiveForModel(clineRow, ["text"], { required: true });
    expect(clineEffective.get("text")?.quarantine).toBe("none");
  });

  it("marks a reviewed claim stale on version drift and never leaves it trusted", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const claimStore = new ClaimEvidenceStore(controlPlane);
    const reviews = new ReviewDecisionStore(controlPlane);
    // An observed-version claim keyed to a NON-baseline client version (#123
    // drift surveillance): the freshness engine flags it stale against the
    // pinned baseline — a stale positive never stays VERIFIED.
    const driftedClaim = passedClaim("text", { ...IDENTITY, clientVersion: "claude-code-2.1.231" });
    await claimStore.writeClaim(driftedClaim);
    await reviews.addDecision({ claimKey: driftedClaim.claimKey, feature: "text", decision: "promote", evidenceRevision: evidenceRevisionFor(driftedClaim), reviewer: "owner", source: "test", reason: "reviewed", decidedAt: "1970-01-02T00:00:00.000Z", rlyBuildVersion: "rly-test-build" });
    const registryStore = registryFor(controlPlane);
    const effective = await registryStore.effectiveForClaimKey(driftedClaim.claimKey, "text", { required: true });
    expect(effective.effective).toBe("stale");
    expect(effective.freshness).toBe("stale");
    expect(effective.freshnessReason).toBe("client-version-drift");
    expect(effective.enforcement).toBe("blocked");
    expect(effective.enforcementReason).toBe("stale-positive-not-trusted");
  });

  it("builds an in-memory snapshot for pure routing consumers", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const claimStore = new ClaimEvidenceStore(controlPlane);
    const reviews = new ReviewDecisionStore(controlPlane);
    const claim = passedClaim("text");
    await claimStore.writeClaim(claim);
    await reviews.addDecision({ claimKey: claim.claimKey, feature: "text", decision: "promote", evidenceRevision: evidenceRevisionFor(claim), reviewer: "owner", source: "test", reason: "reviewed", decidedAt: "1970-01-02T00:00:00.000Z", rlyBuildVersion: "rly-test-build" });
    const registryStore = registryFor(controlPlane);
    const row = codexRow();
    const snapshot = await registryStore.snapshotForModels([row], () => ["text"] as const, { required: false });
    const text = snapshot.get(row.logicalId)?.get("text");
    expect(text?.effective).toBe("trusted");
  });

  it("produces a secret-free explanation for doctor", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const registryStore = registryFor(controlPlane);
    const row = codexRow();
    const explanation = await registryStore.explain(row, ["text"]);
    expect(explanation.logicalId).toBe("codex/gpt-5.4");
    expect(explanation.seedOnly).toBe(true);
    expect(explanation.features.text).toBeDefined();
    // Claim identity IS part of the explanation; the forbidden patterns are
    // exact secret/identity KEY names, never substring matches on claimIdentity.
    expect(JSON.stringify(explanation)).not.toMatch(/"(accessToken|refreshToken|authorization|token|secret|password|email|prompt|response)"/);
  });

  it("exposes a secret-free summary of durable authority state", async () => {
    const directory = await temporaryDirectory();
    const controlPlane = join(directory, "control-plane");
    const registryStore = registryFor(controlPlane);
    const summary = await registryStore.summary();
    expect(summary.policy.supportedClientBaseline).toBe(CLAUDE_CODE_CONTRACT.baseline);
    expect(summary.policy.allowQuarantineBypass).toBe(false);
    expect(summary.reviews.decisionCount).toBe(0);
    expect(summary.quarantines.activeCount).toBe(0);
  });
});
