import { describe, expect, it } from "vitest";
import { assertSecretFree } from "../../src/control-plane/secret-free.js";
import { RLY_MODEL_PREFIX } from "../../src/routing/model-projection/types.js";
import { assembleEffectiveModelDecision, environmentOwnershipSummary } from "../../src/routing/model-decision/assemble.js";
import { describeModelDecision } from "../../src/routing/model-decision/describe.js";
import type { EffectiveModelDecisionInput } from "../../src/routing/model-decision/types.js";

/**
 * EffectiveModelDecision privacy (#127): decision/describe output is
 * allowlisted metadata only — never prompts, responses, reasoning text,
 * credentials, authorization headers, raw account identity, or full user
 * settings content. The whole object must pass the control-plane
 * `assertSecretFree` gate and the privacy scan.
 */

function fullDecisionInput(overrides: Partial<EffectiveModelDecisionInput> = {}): EffectiveModelDecisionInput {
  return {
    requestId: "req-privacy-001",
    profileId: "profile-privacy-1",
    profileName: "privacy",
    viewId: "default",
    intent: { kind: "EXACT_CLIENT_MODEL", sourceSelector: "gpt-5.6-terra", source: "exact-model", modelId: "gpt-5.6-terra", role: "primary" },
    resolvedModelId: "gpt-5.6-terra",
    logicalId: "cline/gpt-5.6-terra",
    accessProviderId: "cline",
    adapterId: "cline-interop",
    modelFamily: "openai/codex",
    poolId: "pool-privacy-1",
    policyRevision: 7,
    policyHash: "b".repeat(64),
    registryRevision: 5,
    sessionUniverseRevision: 7,
    experimentalModels: false,
    reasoning: {
      requested: { intent: "BALANCED", explicit: false },
      canonicalIntent: "BALANCED",
      effective: { kind: "binary", enabled: true },
      mappingKind: "normalized",
    },
    selection: {
      source: "exact",
      selectedLogicalId: "cline/gpt-5.6-terra",
      reason: "exact-evidence",
      candidates: [{
        logicalId: "cline/gpt-5.6-terra",
        accessProviderId: "cline",
        modelId: "gpt-5.6-terra",
        modelFamily: "openai/codex",
        compatibilityState: "EXPERIMENTAL",
        capabilityPass: true,
        reasoningPass: true,
        compatibilityPass: true,
        authority: "ecr",
        effectiveLabel: "experimental",
        enforcementReason: "explicit-experimental-override",
        selected: true,
      }],
    },
    profileRole: "primary",
    persistedViewModel: `${RLY_MODEL_PREFIX}cline-aaa111`,
    environmentOwnership: environmentOwnershipSummary({
      ANTHROPIC_AUTH_TOKEN: "fixture-token",
      OPENAI_API_KEY: "fixture-key",
    }),
    decidedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

const SECRET_MARKERS = [
  /access-token/i,
  /refresh-token/i,
  /authorization/i,
  /prompt/i,
  /response/i,
  /reasoning text/i,
  /@/,
  /bearer /i,
];

describe("EffectiveModelDecision privacy (#127)", () => {
  it("passes the control-plane assertSecretFree gate for the decision and its description", () => {
    const decision = assembleEffectiveModelDecision(fullDecisionInput());
    expect(() => assertSecretFree(decision)).not.toThrow();
    const described = describeModelDecision(decision);
    expect(() => assertSecretFree(described)).not.toThrow();
  });

  it("exposes only allowlisted metadata — no user content, credentials, or identity", () => {
    const decision = assembleEffectiveModelDecision(fullDecisionInput());
    const serialized = JSON.stringify(decision);
    for (const marker of SECRET_MARKERS) {
      expect(serialized).not.toMatch(marker);
    }
    // Values that exist are routing metadata only.
    expect(serialized).toContain("gpt-5.6-terra");
    expect(serialized).toContain("cline");
    expect(serialized).toContain("experimental");
    // Never actual credential values.
    expect(serialized).not.toContain("fixture-token");
    expect(serialized).not.toContain("fixture-key");
  });

  it("keeps the describe surface secret-free with the same allowlist", () => {
    const decision = assembleEffectiveModelDecision(fullDecisionInput());
    const described = describeModelDecision(decision);
    const serialized = JSON.stringify(described);
    for (const marker of SECRET_MARKERS) {
      expect(serialized).not.toMatch(marker);
    }
    // Env/settings ownership is counts + key NAMES only (never values); the
    // actual credential VALUES never appear anywhere.
    expect(serialized).not.toContain("fixture-token");
    expect(serialized).not.toContain("fixture-key");
  });

  it("never includes account/credential identity even when inputs carry conflicts", () => {
    const decision = assembleEffectiveModelDecision(fullDecisionInput({
      launchPolicyModel: "gpt-5.6-sol",
      parent: { parentModelId: "gpt-5.6-sol", contextSource: "parent-agent" },
    }));
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toMatch(/accountPseudonym|credentialGeneration|acct-|accountId/i);
    expect(serialized).not.toMatch(/fixture-token|fixture-key/);
  });

  it("keeps reasoning metadata free of reasoning text and thinking content", () => {
    const decision = assembleEffectiveModelDecision(fullDecisionInput({
      reasoning: {
        requested: { intent: "DEEP", sourceEffort: "high", explicit: true },
        canonicalIntent: "DEEP",
        effective: { kind: "effort", level: "high" },
        mappingKind: "exact",
      },
    }));
    const serialized = JSON.stringify(decision);
    expect(serialized).toContain('"canonicalIntent":"DEEP"');
    expect(serialized).not.toMatch(/thinking|reasoning text|thought|analysis/i);
  });
});
