import { describe, expect, it } from "vitest";
import { reviewedModel, type ModelEvidence, type RegistryDocument } from "../../src/registry/model-registry.js";
import { projectModelUniverse, resolveProjection } from "../../src/routing/model-projection/project.js";
import type { ModelUniverseSnapshot } from "../../src/routing/model-projection/types.js";

/**
 * Canary → #72 projection gate (#24). `GET /v1/models` must consume the
 * canary-derived compatibility state: VERIFIED by default, EXPERIMENTAL only
 * with the explicit `gateway.modelDiscovery.experimentalModels` opt-in,
 * BROKEN/unreviewed never. The same upstream model through two access
 * providers keeps independent states — no cross-provider evidence reuse.
 */

const capabilities = {
  streaming: true, tools: true, parallelTools: false, images: false,
  reasoning: true, redactedReasoning: false, structuredOutput: false,
  tokenCounting: "conservative-estimate" as const,
};

function model(provider: string, upstreamModelId: string, state: "VERIFIED" | "EXPERIMENTAL" | "BROKEN"): ModelEvidence {
  return reviewedModel({
    accessProviderId: provider,
    upstreamModelId,
    modelFamily: "openai/codex",
    verifiedAt: "2026-08-13",
    fixtureVersion: "openai-chat-v1",
    capabilities,
    compatibility: { state, baseline: "claude-code-2.1.229", evidenceRef: "canary:claude-code-2.1.229-contract-v1" },
  });
}

function registry(models: readonly ModelEvidence[]): RegistryDocument {
  return Object.freeze({ registryRevision: 4, models: Object.freeze(models) });
}

function snapshot(registry: RegistryDocument, experimentalModels = false): ModelUniverseSnapshot {
  return Object.freeze({
    policyRevision: 1,
    policyHash: "policy-hash",
    registryRevision: registry.registryRevision,
    bindings: Object.freeze([
      Object.freeze({ providerId: "codex", providerName: "codex", poolId: "pool-codex" }),
      Object.freeze({ providerId: "cline", providerName: "cline", poolId: "pool-cline" }),
    ]),
    experimentalModels,
  });
}

describe("canary-derived compatibility state gates the #72 projection", () => {
  it("projects VERIFIED access paths by default and excludes BROKEN/unreviewed", () => {
    const registryWithCanaryStates = registry([model("codex", "gpt-5.4", "VERIFIED")]);
    const projections = projectModelUniverse(registryWithCanaryStates, snapshot(registryWithCanaryStates));
    expect(projections.map((projection) => projection.upstreamModelId)).toEqual(["gpt-5.4"]);
    expect(projections[0]?.compatibilityState).toBe("VERIFIED");
  });

  it("excludes EXPERIMENTAL by default and includes it only with the explicit opt-in", () => {
    const experimental = registry([model("codex", "gpt-5.4", "EXPERIMENTAL")]);
    expect(projectModelUniverse(experimental, snapshot(experimental)).length).toBe(0);
    const optedIn = projectModelUniverse(experimental, snapshot(experimental, true));
    expect(optedIn.map((projection) => projection.upstreamModelId)).toEqual(["gpt-5.4"]);
  });

  it("never projects BROKEN even with the opt-in and fails closed on reverse mapping", () => {
    const broken = registry([model("codex", "gpt-5.4", "BROKEN")]);
    const projections = projectModelUniverse(broken, snapshot(broken, true));
    expect(projections.length).toBe(0);
    expect(resolveProjection("claude-rly-codex-anything", snapshot(broken, true), broken)).toBeUndefined();
  });

  it("keeps the same upstream model through two providers independent (no evidence reuse)", () => {
    const independent = registry([model("codex", "gpt-5.4", "VERIFIED"), model("cline", "gpt-5.4", "BROKEN")]);
    const projections = projectModelUniverse(independent, snapshot(independent));
    expect(projections.map((projection) => projection.providerName)).toEqual(["codex"]);
    // The BROKEN ClinePass path resolves to nothing; the VERIFIED Codex path resolves exactly.
    const resolved = resolveProjection(projections[0]?.id ?? "", snapshot(independent), independent);
    expect(resolved?.evidence.identity.accessProviderId).toBe("codex");
    expect(resolved?.binding.poolId).toBe("pool-codex");
  });

  it("rejects a projection whose canary state was removed from the registry", () => {
    const before = registry([model("codex", "gpt-5.4", "VERIFIED")]);
    const issued = projectModelUniverse(before, snapshot(before))[0];
    if (issued === undefined) throw new Error("expected a VERIFIED projection");
    const removed = registry([]);
    expect(resolveProjection(issued.id, snapshot(before), removed)).toBeUndefined();
  });
});
