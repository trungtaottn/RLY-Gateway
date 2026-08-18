import { describe, expect, it } from "vitest";
import type { ProviderCapabilities, ReasoningCapabilityEvidence } from "../../src/core/capabilities.js";
import {
  MODEL_REGISTRY_REVISION,
  reviewedModel,
  type RegistryDocument,
} from "../../src/registry/model-registry.js";
import { TierResolutionError } from "../../src/routing/model-tiers/errors.js";
import { defaultTierMapping } from "../../src/routing/model-tiers/mapping.js";
import { resolveTier } from "../../src/routing/model-tiers/resolver.js";
import {
  isLogicalTier,
  LOGICAL_TIERS,
  parseLogicalTier,
  type TierMappingPolicy,
  type TierResolutionContext,
} from "../../src/routing/model-tiers/types.js";

function caps(overrides: Record<string, boolean> = {}): ProviderCapabilities {
  return Object.freeze({
    streaming: true,
    tools: true,
    parallelTools: false,
    images: false,
    reasoning: true,
    redactedReasoning: false,
    structuredOutput: false,
    tokenCounting: "conservative-estimate",
    ...overrides,
  });
}

const reasoningWithTools: ReasoningCapabilityEvidence = Object.freeze({
  supported: true,
  controlKind: "binary",
  adaptive: false,
  tokenBudget: false,
  reasoningWithTools: true,
});

/**
 * ClinePass aggregator fixtures (#69): one access provider exposing several
 * upstream families at once. Terra-class parent + `fable` must stay inside the
 * OpenAI/Codex family (Sol), DeepSeek Flash parent stays in DeepSeek (Pro),
 * Anthropic parent stays in Anthropic (fable-tier target). A separate family
 * with only BROKEN evidence and an EXPERIMENTAL-only provider cover fail-closed
 * and opt-in paths.
 */
const clineAggregatorRegistry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    // OpenAI/Codex family
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "gpt-5.6-terra", modelFamily: "openai/codex",
      verifiedAt: "2026-08-21", fixtureVersion: "cli-interop-chat-v1", capabilities: caps(), reasoning: reasoningWithTools,
      compatibility: { state: "VERIFIED", baseline: "claude-code-2.1.229", evidenceRef: "verify-terra", checkedAt: "2026-08-21" },
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "gpt-5.6-sol", modelFamily: "openai/codex",
      verifiedAt: "2026-08-21", fixtureVersion: "cli-interop-chat-v1", capabilities: caps(), reasoning: reasoningWithTools,
      compatibility: { state: "VERIFIED", baseline: "claude-code-2.1.229", evidenceRef: "verify-sol", checkedAt: "2026-08-21" },
    }),
    // DeepSeek family
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "deepseek-v4-flash", modelFamily: "deepseek",
      verifiedAt: "2026-08-21", fixtureVersion: "cli-interop-chat-v1", capabilities: caps({ tools: false }),
      compatibility: { state: "VERIFIED", baseline: "claude-code-2.1.229", evidenceRef: "verify-ds-flash", checkedAt: "2026-08-21" },
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "deepseek-v4-pro", modelFamily: "deepseek",
      verifiedAt: "2026-08-21", fixtureVersion: "cli-interop-chat-v1", capabilities: caps({ tools: false }),
      compatibility: { state: "VERIFIED", baseline: "claude-code-2.1.229", evidenceRef: "verify-ds-pro", checkedAt: "2026-08-21" },
    }),
    // Anthropic family
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "claude-sonnet-4-5", modelFamily: "anthropic",
      verifiedAt: "2026-08-21", fixtureVersion: "cli-interop-chat-v1", capabilities: caps(),
      compatibility: { state: "VERIFIED", baseline: "claude-code-2.1.229", evidenceRef: "verify-an-sonnet", checkedAt: "2026-08-21" },
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "claude-opus-4-8", modelFamily: "anthropic",
      verifiedAt: "2026-08-21", fixtureVersion: "cli-interop-chat-v1", capabilities: caps(),
      compatibility: { state: "VERIFIED", baseline: "claude-code-2.1.229", evidenceRef: "verify-an-opus", checkedAt: "2026-08-21" },
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "claude-fable", modelFamily: "anthropic",
      verifiedAt: "2026-08-21", fixtureVersion: "cli-interop-chat-v1", capabilities: caps(),
      compatibility: { state: "VERIFIED", baseline: "claude-code-2.1.229", evidenceRef: "verify-an-fable", checkedAt: "2026-08-21" },
    }),
    // Same-family EXPERIMENTAL candidate (must not win over VERIFIED on the derived path)
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "gpt-5.4", modelFamily: "openai/codex",
      verifiedAt: "2026-08-21", fixtureVersion: "cli-interop-chat-v1", capabilities: caps(),
    }),
    // Family whose only candidate is BROKEN (derived must fail closed)
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "mistral-claims", modelFamily: "mistral",
      verifiedAt: "2026-08-21", fixtureVersion: "cli-interop-chat-v1", capabilities: caps(),
      compatibility: { state: "BROKEN", baseline: "claude-code-2.1.229", evidenceRef: "canary-9", checkedAt: "2026-08-21" },
    }),
    // Another access provider for explicit cross-provider fallback only
    reviewedModel({
      accessProviderId: "codex", upstreamModelId: "gpt-5.4", modelFamily: "openai/codex",
      verifiedAt: "2026-08-21", fixtureVersion: "codex-oauth-chat-v1", capabilities: caps(), reasoning: reasoningWithTools,
      compatibility: { state: "VERIFIED", baseline: "claude-code-2.1.229", evidenceRef: "verify-codex", checkedAt: "2026-08-21" },
    }),
  ]),
});

/** Direct single-family provider with one reviewed model (no tier mapping rows). */
const directSingleFamilyRegistry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    reviewedModel({
      accessProviderId: "deepseek", upstreamModelId: "deepseek-v4-flash", modelFamily: "deepseek",
      verifiedAt: "2026-08-21", fixtureVersion: "openai-chat-v1", capabilities: caps({ tools: false }),
      compatibility: { state: "VERIFIED", baseline: "claude-code-2.1.229", evidenceRef: "verify-d", checkedAt: "2026-08-21" },
    }),
  ]),
});

/** A provider whose only candidate is EXPERIMENTAL (derived default policy must reject). */
const experimentalOnlyRegistry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    reviewedModel({
      accessProviderId: "exp-provider", upstreamModelId: "exp-model", modelFamily: "alpha",
      verifiedAt: "2026-08-21", fixtureVersion: "f1", capabilities: caps(),
    }),
  ]),
});

function context(overrides: Partial<TierResolutionContext> = {}): TierResolutionContext {
  return {
    requestedTier: "fable",
    accessProviderId: "cline",
    allowCrossFamilyFallback: false,
    allowCrossProviderFallback: false,
    ...overrides,
  };
}

function expectFailure(input: TierResolutionContext, code: string, registry = clineAggregatorRegistry): void {
  try {
    resolveTier(input, { registry, mapping: defaultTierMapping });
    expect.unreachable("expected a TierResolutionError");
  } catch (error) {
    expect(error).toBeInstanceOf(TierResolutionError);
    expect((error as TierResolutionError).code).toBe(code);
  }
}

describe("logical tier typing (#69)", () => {
  it("represents haiku/sonnet/opus/fable as typed logical tiers separate from physical ids", () => {
    expect(LOGICAL_TIERS).toEqual(["haiku", "sonnet", "opus", "fable"]);
    for (const tier of LOGICAL_TIERS) expect(isLogicalTier(tier)).toBe(true);
    expect(isLogicalTier("gpt-5.6-sol")).toBe(false);
    expect(isLogicalTier("claude-sonnet-4-5")).toBe(false);
    expect(parseLogicalTier("fable")).toBe("fable");
    expect(parseLogicalTier("gpt-5.6-sol")).toBeUndefined();
  });
});

describe("provider/family-scoped tier resolution (#69)", () => {
  it("receives both access-provider and model-family/parent context", () => {
    const result = resolveTier(context({ parentModelId: "gpt-5.6-terra" }), { registry: clineAggregatorRegistry, mapping: defaultTierMapping });
    expect(result.trace.accessProviderId).toBe("cline");
    expect(result.trace.modelFamily).toBe("openai/codex");
    expect(result.trace.parentModelId).toBe("gpt-5.6-terra");
    expect(result.trace.requestedTier).toBe("fable");
  });

  it("resolves fable to the verified Sol-family candidate for a Terra-family parent (not Anthropic/DeepSeek)", () => {
    const result = resolveTier(context({ parentModelId: "gpt-5.6-terra" }), { registry: clineAggregatorRegistry, mapping: defaultTierMapping });
    expect(result.model.logicalId).toBe("cline/gpt-5.6-sol");
    expect(result.trace.mappingSource).toBe("reviewed-mapping");
    expect(result.trace.reason).toBe("reviewed-mapping-match");
    expect(result.trace.selectedLogicalId).toBe("cline/gpt-5.6-sol");
  });

  it("resolves fable to the verified V4 Pro candidate for a DeepSeek V4 Flash-family parent", () => {
    const result = resolveTier(context({ parentModelId: "deepseek-v4-flash" }), { registry: clineAggregatorRegistry, mapping: defaultTierMapping });
    expect(result.model.logicalId).toBe("cline/deepseek-v4-pro");
    expect(result.trace.mappingSource).toBe("reviewed-mapping");
  });

  it("stays in the Anthropic family for an Anthropic-family parent according to its reviewed mapping", () => {
    const result = resolveTier(context({ parentModelId: "claude-sonnet-4-5" }), { registry: clineAggregatorRegistry, mapping: defaultTierMapping });
    expect(result.model.logicalId).toBe("cline/claude-fable");
    expect(result.trace.modelFamily).toBe("anthropic");
    // The stronger DeepSeek/Codex candidates never win across families.
    expect(result.model.identity.modelFamily).toBe("anthropic");
  });

  it("keeps a direct single-family provider scoped to that provider for every tier", () => {
    const result = resolveTier(
      context({ accessProviderId: "deepseek", parentModelId: "deepseek-v4-flash" }),
      { registry: directSingleFamilyRegistry, mapping: defaultTierMapping },
    );
    expect(result.model.logicalId).toBe("deepseek/deepseek-v4-flash");
    expect(result.trace.mappingSource).toBe("derived");
    expect(result.trace.modelFamily).toBe("deepseek");
    // Fewer physical tiers than logical tiers: haiku resolves to the same family winner.
    const haiku = resolveTier(
      context({ accessProviderId: "deepseek", parentModelId: "deepseek-v4-flash", requestedTier: "haiku" }),
      { registry: directSingleFamilyRegistry, mapping: defaultTierMapping },
    );
    expect(haiku.model.logicalId).toBe("deepseek/deepseek-v4-flash");
    expect(haiku.trace.mappingSource).toBe("derived");
  });

  it("derives deterministically inside the same provider+family when no mapping exists", () => {
    const result = resolveTier(context({ parentModelId: "gpt-5.6-terra", requestedTier: "haiku" }), { registry: clineAggregatorRegistry, mapping: defaultTierMapping });
    // No reviewed haiku row for openai/codex: deterministic #68 winner in family.
    expect(result.model.logicalId).toBe("cline/gpt-5.6-terra");
    expect(result.trace.mappingSource).toBe("derived");
    expect(result.trace.reason).toBe("deterministic-family-candidate");
    // The EXPERIMENTAL same-family candidate never wins over VERIFIED.
    expect(result.model.compatibility.state).toBe("VERIFIED");
  });

  it("fails closed with tier-unavailable when no eligible same-family target exists and fallback is disabled", () => {
    expectFailure(context({ parentModelId: "mistral-claims" }), "tier-unavailable");
    expectFailure(context({ parentModelId: "gpt-5.6-terra", requestedTier: "haiku" }), "tier-unavailable", experimentalOnlyRegistry);
  });

  it("applies cross-family fallback only when explicitly enabled and records it in the trace", () => {
    const disabled = context({ parentModelId: "mistral-claims" });
    expectFailure(disabled, "tier-unavailable");
    const enabled = resolveTier(
      context({ parentModelId: "mistral-claims", allowCrossFamilyFallback: true }),
      { registry: clineAggregatorRegistry, mapping: defaultTierMapping },
    );
    expect(enabled.trace.mappingSource).toBe("fallback");
    expect(enabled.trace.fallbackReason).toBe("cross-family (explicitly enabled)");
    // Still provider-scoped: never jumps to another access provider implicitly.
    expect(enabled.model.identity.accessProviderId).toBe("cline");
  });

  it("applies cross-provider fallback only with an explicit provider list", () => {
    // Flag on but no provider list: fail closed, never derive a provider list.
    expectFailure(context({ parentModelId: "mistral-claims", allowCrossProviderFallback: true }), "tier-unavailable");
    const enabled = resolveTier(
      context({ parentModelId: "mistral-claims", allowCrossFamilyFallback: true, allowCrossProviderFallback: true }),
      { registry: clineAggregatorRegistry, mapping: defaultTierMapping, fallbackProviderIds: ["codex"] },
    );
    // Cross-family leg succeeds first in search order; provider stays cline.
    expect(enabled.model.identity.accessProviderId).toBe("cline");
    // Provider-level: unknown family + explicit codex list resolves inside codex.
    const providerFallback = resolveTier(
      context({ accessProviderId: "cline", allowCrossProviderFallback: true }),
      { registry: clineAggregatorRegistry, mapping: defaultTierMapping, fallbackProviderIds: ["codex"] },
    );
    expect(providerFallback.model.logicalId).toBe("codex/gpt-5.4");
    expect(providerFallback.trace.fallbackReason).toBe("cross-provider (explicitly enabled): codex");
  });

  it("fails closed with family-unknown for a multi-family provider without parent/family context", () => {
    expectFailure(context({}), "tier-unavailable");
    const error = catchError(context({}), clineAggregatorRegistry);
    expect(error?.causeCode).toBe("family-unknown");
  });

  it("honors an explicit user override and rejects unknown/broken targets", () => {
    const override = resolveTier(
      context({ parentModelId: "gpt-5.6-terra", explicitUserMapping: "deepseek-v4-pro" }),
      { registry: clineAggregatorRegistry, mapping: defaultTierMapping },
    );
    expect(override.model.logicalId).toBe("cline/deepseek-v4-pro");
    expect(override.trace.mappingSource).toBe("user-override");
    expectFailure(context({ explicitUserMapping: "not-reviewed" }), "override-rejected");
    expectFailure(context({ explicitUserMapping: "mistral-claims" }), "override-rejected");
  });

  it("fails closed when a reviewed mapping entry has no trusted/compatible evidence", () => {
    const staleMapping: TierMappingPolicy = Object.freeze({
      revision: 2,
      entries: Object.freeze({ "cline|openai/codex|fable": "ghost-model" }),
    });
    try {
      resolveTier(context({ parentModelId: "gpt-5.6-terra" }), { registry: clineAggregatorRegistry, mapping: staleMapping });
      expect.unreachable("expected a TierResolutionError");
    } catch (error) {
      expect(error).toBeInstanceOf(TierResolutionError);
      expect((error as TierResolutionError).code).toBe("mapping-invalid");
    }
  });

  it("rejects EXPERIMENTAL derived candidates under the default policy and accepts an explicit opt-in", () => {
    expectFailure(
      context({ accessProviderId: "exp-provider", parentModelId: "exp-model", requestedTier: "opus" }),
      "tier-unavailable",
      experimentalOnlyRegistry,
    );
    const optedIn = resolveTier(
      context({ accessProviderId: "exp-provider", parentModelId: "exp-model", requestedTier: "opus" }),
      { registry: experimentalOnlyRegistry, mapping: defaultTierMapping, allowExperimental: true },
    );
    expect(optedIn.model.logicalId).toBe("exp-provider/exp-model");
    expect(optedIn.trace.mappingSource).toBe("derived");
  });

  it("is deterministic and records the immutable mapping/registry revisions", () => {
    const input = context({ parentModelId: "gpt-5.6-terra" });
    const first = resolveTier(input, { registry: clineAggregatorRegistry, mapping: defaultTierMapping });
    const second = resolveTier(input, { registry: clineAggregatorRegistry, mapping: defaultTierMapping });
    expect(first.model.logicalId).toBe(second.model.logicalId);
    expect(first.trace).toEqual(second.trace);
    expect(first.trace.mappingRevision).toBe(defaultTierMapping.revision);
    expect(first.trace.registryRevision).toBe(MODEL_REGISTRY_REVISION);
    // A frozen mapping policy cannot change a session's target between requests.
    expect(Object.isFrozen(defaultTierMapping.entries)).toBe(true);
    expect(Object.isFrozen(clineAggregatorRegistry.models)).toBe(true);
  });

  it("records a frozen, secret-free decision trace with allowlisted metadata only", () => {
    const result = resolveTier(context({ parentModelId: "gpt-5.6-terra" }), { registry: clineAggregatorRegistry, mapping: defaultTierMapping });
    expect(Object.isFrozen(result.trace)).toBe(true);
    const trace = result.trace as unknown as Record<string, unknown>;
    expect(Object.keys(trace)).toEqual([
      "requestedTier", "accessProviderId", "modelFamily", "parentModelId",
      "mappingSource", "selectedLogicalId", "reason", "mappingRevision", "registryRevision",
    ]);
    const forbidden = new Set(["accessToken", "refreshToken", "authorization", "token", "secret", "password", "email", "prompt", "response", "pseudonym", "credentialHandle", "accountId"]);
    const walk = (value: unknown, path: string): string[] => {
      if (value === null || typeof value !== "object") return [];
      const findings: string[] = [];
      for (const [key, child] of Object.entries(value)) {
        if (forbidden.has(key)) findings.push(`${path}.${key}`);
        findings.push(...walk(child, `${path}.${key}`));
      }
      return findings;
    };
    expect(walk(result, "result")).toEqual([]);
  });
});

function catchError(input: TierResolutionContext, registry: RegistryDocument): TierResolutionError | undefined {
  try {
    resolveTier(input, { registry, mapping: defaultTierMapping });
    return undefined;
  } catch (error) {
    return error instanceof TierResolutionError ? error : undefined;
  }
}
