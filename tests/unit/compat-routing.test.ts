import { describe, expect, it } from "vitest";
import type { ProviderCapabilities } from "../../src/core/capabilities.js";
import {
  MODEL_REGISTRY_REVISION,
  reviewedModel,
  type ModelEvidence,
  type RegistryDocument,
} from "../../src/registry/model-registry.js";
import { selectModel } from "../../src/routing/model-selection/selector.js";
import { ModelSelectionError } from "../../src/routing/model-selection/errors.js";
import type { EffectiveSelectionSnapshot } from "../../src/routing/model-selection/types.js";
import { resolveTier } from "../../src/routing/model-tiers/resolver.js";
import { projectModelUniverse, resolveProjection } from "../../src/routing/model-projection/project.js";
import type { ModelUniverseSnapshot } from "../../src/routing/model-projection/types.js";
import { resolveEffectiveCompatibility } from "../../src/compatibility/effective.js";
import { passedClaim, promoteDecision, quarantineRecord, pinnedPolicy, IDENTITY } from "../helpers/compat.js";
import type { ClaimFeature } from "../../src/canary/claim.js";
import type { EffectiveCompatibility, QuarantineRecord, ReviewDecision } from "../../src/compatibility/types.js";
import { claimKeyFor } from "../../src/canary/claim.js";

/**
 * Runtime-consumer integration (#124): selector, tier resolver, and projection
 * treat the Effective Compatibility Registry snapshot as the compatibility
 * AUTHORITY — quarantined/required features fail closed (no silent fallback),
 * PASS alone is never trusted, and legacy static states are seed/reference only.
 */

function capabilities(): ProviderCapabilities {
  return Object.freeze({
    streaming: true, tools: true, parallelTools: false, images: false, reasoning: true,
    redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate",
  });
}

function row(accessProviderId: string, upstreamModelId: string, modelFamily: string, state: "VERIFIED" | "EXPERIMENTAL" | "BROKEN" = "EXPERIMENTAL"): ModelEvidence {
  return reviewedModel({
    accessProviderId,
    upstreamModelId,
    modelFamily,
    verifiedAt: "2026-08-21",
    fixtureVersion: "cline-interop-chat-v1",
    capabilities: capabilities(),
    compatibility: {
      state,
      baseline: "claude-code-fake-upstream",
      evidenceRef: "e2e-1",
      checkedAt: "2026-08-21",
    },
  });
}

const registry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    row("cline", "gpt-5.6-sol", "openai/codex"),
    row("cline", "gpt-5.6-terra", "openai/codex"),
    row("cline", "deepseek-v4-pro", "deepseek"),
    row("deepseek", "deepseek-v4-flash", "deepseek", "BROKEN"),
  ]),
});

/** Builds a per-feature ECR answer for one model using the pure resolver. */
function effectiveFor(
  model: ModelEvidence,
  features: readonly string[],
  opts: Readonly<{ decisions?: ReviewDecision[]; quarantines?: QuarantineRecord[]; claimFeature?: string }> = {},
): ReadonlyMap<ClaimFeature, EffectiveCompatibility> {
  const map = new Map<ClaimFeature, EffectiveCompatibility>();
  for (const feature of features) {
    const identity = { ...IDENTITY, accessProviderId: model.identity.accessProviderId, adapterId: "cline-interop", authMode: "interop-import" as const, physicalModelId: model.identity.upstreamModelId, ...(model.identity.modelFamily === undefined ? {} : { modelFamily: model.identity.modelFamily }) };
    const claim = passedClaim(feature as ClaimFeature, identity);
    map.set(feature as ClaimFeature, resolveEffectiveCompatibility({
      claimKey: claimKeyFor(identity, feature as ClaimFeature),
      feature: feature as ClaimFeature,
      claim,
      decisions: opts.decisions ?? [promoteDecision(claim)],
      quarantines: opts.quarantines ?? [],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: false,
      allowQuarantineBypass: false,
    }));
  }
  return map;
}

function snapshotFor(models: readonly ModelEvidence[]): EffectiveSelectionSnapshot {
  const snapshot = new Map<string, ReadonlyMap<ClaimFeature, EffectiveCompatibility>>();
  for (const model of models) {
    snapshot.set(model.logicalId, effectiveFor(model, ["text", "streaming", "cancellation", "tools-single", "reasoning"]));
  }
  return snapshot;
}

describe("#68 selector consumes the ECR (#124)", () => {
  it("blocks a quarantined required feature fail-closed with no fallback", () => {
    const model = row("cline", "gpt-5.6-sol", "openai/codex");
    const quarantined = new Map<string, ReadonlyMap<ClaimFeature, EffectiveCompatibility>>();
    const featureMap = effectiveFor(model, ["text"], {
      decisions: [promoteDecision(passedClaim("text", { ...IDENTITY, accessProviderId: "cline", adapterId: "cline-interop", authMode: "interop-import" as const, physicalModelId: "gpt-5.6-sol" }))],
      quarantines: [quarantineRecord(claimKeyFor({ ...IDENTITY, accessProviderId: "cline", adapterId: "cline-interop", authMode: "interop-import" as const, physicalModelId: "gpt-5.6-sol" }, "text"), "text")],
    });
    quarantined.set(model.logicalId, featureMap);
    const error = (): unknown => selectModel(
      { accessProviderId: "cline", exactModelId: "gpt-5.6-sol", requiredCapabilities: [] },
      registry,
      { effective: quarantined },
    );
    expect(error).toThrow(ModelSelectionError);
    try {
      error();
    } catch (caught) {
      const err = caught as ModelSelectionError;
      expect(err.code).toBe("compatibility-rejected");
    }
  });

  it("treats a reviewed claim as trusted and selects it", () => {
    const model = row("cline", "gpt-5.6-sol", "openai/codex");
    const snapshot = snapshotFor([model]);
    const selection = selectModel(
      { accessProviderId: "cline", exactModelId: "gpt-5.6-sol", requiredCapabilities: ["reasoning"] },
      registry,
      { effective: snapshot },
    );
    expect(selection.model.logicalId).toBe("cline/gpt-5.6-sol");
    const assessment = selection.decision.candidates[0];
    expect(assessment?.authority).toBe("ecr");
    expect(assessment?.compatibilityPass).toBe(true);
  });

  it("marks PASS-only (unreviewed) claims experimental and blocks by default, allows with the exact-pin opt-in", () => {
    const model = row("cline", "gpt-5.6-sol", "openai/codex");
    const snapshot = new Map<string, ReadonlyMap<ClaimFeature, EffectiveCompatibility>>();
    const featureMap = effectiveFor(model, ["text", "cancellation"], { decisions: [] });
    snapshot.set(model.logicalId, featureMap);
    // Candidate path without opt-in: blocked.
    const blocked = (): unknown => selectModel(
      { accessProviderId: "cline", requiredCapabilities: [] },
      registry,
      { effective: snapshot },
    );
    expect(blocked).toThrow(ModelSelectionError);
    // Exact pin is the explicit opt-in: allowed, traceable in the decision.
    const selection = selectModel(
      { accessProviderId: "cline", exactModelId: "gpt-5.6-sol", requiredCapabilities: [] },
      registry,
      { effective: snapshot },
    );
    expect(selection.decision.candidates[0]?.effectiveLabel).toBe("experimental");
  });

  it("never lets the experimental override bypass evidence-updated-after-review (untrusted)", () => {
    const model = row("cline", "gpt-5.6-sol", "openai/codex");
    const claim = passedClaim("text", { ...IDENTITY, accessProviderId: "cline", adapterId: "cline-interop", authMode: "interop-import" as const, physicalModelId: "gpt-5.6-sol" });
    const decision = promoteDecision(claim);
    const base = claim.records[0];
    if (base === undefined) throw new Error("missing record");
    const updated = { ...claim, records: [...claim.records, Object.freeze({ ...base, checkedAt: "1970-01-09T00:00:00.000Z" })] };
    const map = new Map<string, ReadonlyMap<ClaimFeature, EffectiveCompatibility>>();
    map.set(model.logicalId, new Map([["text", resolveEffectiveCompatibility({
      claimKey: claim.claimKey,
      feature: "text",
      claim: updated,
      decisions: [decision],
      quarantines: [],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: false,
      allowQuarantineBypass: false,
    })]]));
    const error = (): unknown => selectModel(
      { accessProviderId: "cline", exactModelId: "gpt-5.6-sol", requiredCapabilities: [] },
      registry,
      { effective: map },
    );
    expect(error).toThrow(ModelSelectionError);
    try {
      error();
    } catch (caught) {
      const err = caught as ModelSelectionError;
      expect(err.code).toBe("compatibility-rejected");
    }
  });

  it("uses the seed mapping when no ECR snapshot is supplied (tooling path only)", () => {
    const selection = selectModel(
      { accessProviderId: "cline", exactModelId: "gpt-5.6-sol", requiredCapabilities: [] },
      registry,
    );
    expect(selection.model.logicalId).toBe("cline/gpt-5.6-sol");
    expect(selection.decision.candidates[0]?.authority).toBeUndefined();
  });
});

describe("#69 tier resolver consumes the ECR (#124)", () => {
  it("fails closed when a quarantined required feature blocks every tier target", () => {
    const model = row("cline", "gpt-5.6-sol", "openai/codex");
    const map = new Map<string, ReadonlyMap<ClaimFeature, EffectiveCompatibility>>();
    const identity = { ...IDENTITY, accessProviderId: "cline", adapterId: "cline-interop", authMode: "interop-import" as const, physicalModelId: "gpt-5.6-sol" };
    map.set(model.logicalId, new Map([["text", resolveEffectiveCompatibility({
      claimKey: claimKeyFor(identity, "text"),
      feature: "text",
      claim: passedClaim("text", identity),
      decisions: [],
      quarantines: [quarantineRecord(claimKeyFor(identity, "text"), "text")],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: false,
      allowQuarantineBypass: false,
    })]]));
    expect(() => resolveTier(
      { requestedTier: "fable", accessProviderId: "cline", modelFamily: "openai/codex", allowCrossFamilyFallback: false, allowCrossProviderFallback: false },
      { registry, requiredCapabilities: [], effective: map },
    )).toThrow();
  });

  it("resolves a trusted target through the ECR", () => {
    const model = row("cline", "gpt-5.6-sol", "openai/codex");
    const snapshot = snapshotFor([model]);
    const resolution = resolveTier(
      { requestedTier: "fable", accessProviderId: "cline", modelFamily: "openai/codex", allowCrossFamilyFallback: false, allowCrossProviderFallback: false },
      { registry, requiredCapabilities: [], effective: snapshot },
    );
    expect(resolution.model.identity.upstreamModelId).toBe("gpt-5.6-sol");
  });
});

describe("#72 projection consumes the ECR (#124)", () => {
  const snapshot = new Map<string, ReadonlyMap<ClaimFeature, EffectiveCompatibility>>();
  const sol = row("cline", "gpt-5.6-sol", "openai/codex");
  const terra = row("cline", "gpt-5.6-terra", "openai/codex");
  snapshot.set(sol.logicalId, effectiveFor(sol, ["text", "streaming", "cancellation", "tools-single", "reasoning", "model-discovery", "session-attribution", "effort-signal", "long-running-session"]));
  snapshot.set(terra.logicalId, effectiveFor(terra, ["text"], { decisions: [] }));

  const universe: ModelUniverseSnapshot = Object.freeze({
    policyRevision: 7,
    policyHash: "h",
    registryRevision: MODEL_REGISTRY_REVISION,
    bindings: Object.freeze([
      Object.freeze({ providerId: "p-cline", providerName: "cline", poolId: "pool-cline" }),
    ]),
    experimentalModels: false,
  });

  it("projects only effective-trusted paths by default", () => {
    const projections = projectModelUniverse(registry, universe, snapshot);
    const ids = projections.map((entry) => entry.upstreamModelId);
    expect(ids).toContain("gpt-5.6-sol");
    // terra's required features are unreviewed (experimental) → excluded by default.
    expect(ids).not.toContain("gpt-5.6-terra");
    // deepseek-v4-flash is BROKEN seed → excluded.
    expect(ids).not.toContain("deepseek-v4-flash");
  });

  it("exposes experimental paths only through the explicit opt-in", () => {
    const optInUniverse = Object.freeze({ ...universe, experimentalModels: true });
    const projections = projectModelUniverse(registry, optInUniverse, snapshot);
    const ids = projections.map((entry) => entry.upstreamModelId);
    expect(ids).toContain("gpt-5.6-terra");
    expect(ids).not.toContain("deepseek-v4-flash");
  });

  it("never projects a quarantined path even with the opt-in", () => {
    const quarantined = new Map<string, ReadonlyMap<ClaimFeature, EffectiveCompatibility>>();
    const identity = { ...IDENTITY, accessProviderId: "cline", adapterId: "cline-interop", authMode: "interop-import" as const, physicalModelId: "gpt-5.6-sol" };
    quarantined.set(sol.logicalId, new Map([["text", resolveEffectiveCompatibility({
      claimKey: claimKeyFor(identity, "text"),
      feature: "text",
      claim: passedClaim("text", identity),
      decisions: [],
      quarantines: [quarantineRecord(claimKeyFor(identity, "text"), "text")],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: false,
      allowQuarantineBypass: false,
    })]]));
    const optInUniverse = Object.freeze({ ...universe, experimentalModels: true });
    const projections = projectModelUniverse(registry, optInUniverse, quarantined);
    expect(projections.some((entry) => entry.upstreamModelId === "gpt-5.6-sol")).toBe(false);
  });

  it("keeps same-model-different-provider projections isolated", () => {
    const codexSol = row("codex", "gpt-5.6-sol", "openai/codex");
    const codexSnapshot = new Map<string, ReadonlyMap<ClaimFeature, EffectiveCompatibility>>();
    codexSnapshot.set(codexSol.logicalId, effectiveFor(codexSol, ["text"]));
    const mixedRegistry: RegistryDocument = Object.freeze({
      registryRevision: MODEL_REGISTRY_REVISION,
      models: Object.freeze([sol, codexSol]),
    });
    const bothBindings: ModelUniverseSnapshot = Object.freeze({
      ...universe,
      bindings: Object.freeze([
        Object.freeze({ providerId: "p-cline", providerName: "cline", poolId: "pool-cline" }),
        Object.freeze({ providerId: "p-codex", providerName: "codex", poolId: "pool-codex" }),
      ]),
    });
    const mixedSnapshot = new Map<string, ReadonlyMap<ClaimFeature, EffectiveCompatibility>>();
    mixedSnapshot.set(sol.logicalId, effectiveFor(sol, ["text"]));
    mixedSnapshot.set(codexSol.logicalId, effectiveFor(codexSol, ["text"]));
    const projections = projectModelUniverse(mixedRegistry, bothBindings, mixedSnapshot);
    expect(projections.filter((entry) => entry.upstreamModelId === "gpt-5.6-sol")).toHaveLength(2);
    // Quarantining the cline path must not hide the codex path.
    const clineIdentity = { ...IDENTITY, accessProviderId: "cline", adapterId: "cline-interop", authMode: "interop-import" as const, physicalModelId: "gpt-5.6-sol" };
    const quarantinedSnapshot = new Map(mixedSnapshot);
    quarantinedSnapshot.set(sol.logicalId, new Map([["text", resolveEffectiveCompatibility({
      claimKey: claimKeyFor(clineIdentity, "text"),
      feature: "text",
      claim: passedClaim("text", clineIdentity),
      decisions: [],
      quarantines: [quarantineRecord(claimKeyFor(clineIdentity, "text"), "text")],
      policy: pinnedPolicy(),
      required: true,
      experimentalOverride: false,
      allowQuarantineBypass: false,
    })]]));
    const afterQuarantine = projectModelUniverse(mixedRegistry, bothBindings, quarantinedSnapshot);
    expect(afterQuarantine.some((entry) => entry.providerName === "cline" && entry.upstreamModelId === "gpt-5.6-sol")).toBe(false);
    expect(afterQuarantine.some((entry) => entry.providerName === "codex" && entry.upstreamModelId === "gpt-5.6-sol")).toBe(true);
  });

  it("resolves a projection id only for effective-trusted targets", () => {
    const projections = projectModelUniverse(registry, universe, snapshot);
    const solEntry = projections.find((entry) => entry.upstreamModelId === "gpt-5.6-sol");
    expect(solEntry).toBeDefined();
    expect(resolveProjection(solEntry?.id ?? "", universe, registry, snapshot)?.evidence.logicalId).toBe("cline/gpt-5.6-sol");
    // terra is not projected → its id does not resolve.
    const terraId = projections.find((entry) => entry.upstreamModelId === "gpt-5.6-terra")?.id;
    expect(terraId).toBeUndefined();
    expect(resolveProjection("claude-rly-cline-000000000000", universe, registry, snapshot)).toBeUndefined();
  });
});
