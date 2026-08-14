import { describe, expect, it } from "vitest";
import type { ProviderCapabilities, ReasoningCapabilityEvidence } from "../../src/core/capabilities.js";
import {
  MODEL_REGISTRY_REVISION,
  reviewedModel,
  type RegistryDocument,
} from "../../src/registry/model-registry.js";
import { ModelSelectionError } from "../../src/routing/model-selection/errors.js";
import { selectModel } from "../../src/routing/model-selection/selector.js";
import type { ModelSelectionInput } from "../../src/routing/model-selection/types.js";

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

const reasoningOnly: ReasoningCapabilityEvidence = Object.freeze({
  supported: true,
  controlKind: "binary",
  adaptive: false,
  tokenBudget: false,
  reasoningWithTools: false,
});

const noReasoning: ReasoningCapabilityEvidence = Object.freeze({
  supported: false,
  controlKind: "none",
  adaptive: false,
  tokenBudget: false,
  reasoningWithTools: false,
});

/** One aggregator access provider exposing several upstream families at once. */
const aggregatorRegistry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    reviewedModel({
      accessProviderId: "cli", upstreamModelId: "gpt-5.6-terra", modelFamily: "openai/codex",
      verifiedAt: "2026-08-20", fixtureVersion: "cli-interop-chat-v1", capabilities: caps(), reasoning: reasoningWithTools,
      compatibility: { state: "VERIFIED", evidenceRef: "verify-1" },
    }),
    reviewedModel({
      accessProviderId: "cli", upstreamModelId: "claude-sonnet-4-5", modelFamily: "anthropic",
      verifiedAt: "2026-08-20", fixtureVersion: "cli-interop-chat-v1", capabilities: caps(),
      compatibility: { state: "VERIFIED", evidenceRef: "verify-2" },
    }),
    reviewedModel({
      accessProviderId: "cli", upstreamModelId: "deepseek-v4-pro", modelFamily: "deepseek",
      verifiedAt: "2026-08-20", fixtureVersion: "cli-interop-chat-v1", capabilities: caps({ tools: false }), reasoning: reasoningOnly,
      compatibility: { state: "VERIFIED", evidenceRef: "verify-3" },
    }),
    reviewedModel({
      accessProviderId: "cli", upstreamModelId: "gpt-5.4", modelFamily: "openai/codex",
      verifiedAt: "2026-08-20", fixtureVersion: "cli-interop-chat-v1", capabilities: caps(), reasoning: reasoningWithTools,
      // Default EXPERIMENTAL: candidate path must reject unless opted in.
    }),
    reviewedModel({
      accessProviderId: "cli", upstreamModelId: "broken-claims", modelFamily: "openai/codex",
      verifiedAt: "2026-08-20", fixtureVersion: "cli-interop-chat-v1", capabilities: caps(),
      compatibility: { state: "BROKEN", baseline: "claude-code-2.1.229", evidenceRef: "canary-9", checkedAt: "2026-08-21" },
    }),
  ]),
});

/** Same upstream model id reachable through two access providers: separate entries. */
const sharedUpstreamRegistry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    reviewedModel({
      accessProviderId: "openrouter", upstreamModelId: "gpt-5.4", modelFamily: "openai/codex",
      verifiedAt: "2026-08-20", fixtureVersion: "openai-chat-v1", capabilities: caps(),
      compatibility: { state: "VERIFIED", evidenceRef: "verify-o" },
    }),
    reviewedModel({
      accessProviderId: "codex", upstreamModelId: "gpt-5.4", modelFamily: "openai/codex",
      verifiedAt: "2026-08-20", fixtureVersion: "codex-oauth-chat-v1", capabilities: caps(), reasoning: reasoningWithTools,
      compatibility: { state: "VERIFIED", evidenceRef: "verify-c" },
    }),
  ]),
});

/** A provider whose only evidence is a no-reasoning model. */
const noReasoningRegistry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    reviewedModel({
      accessProviderId: "deepseek", upstreamModelId: "deepseek-v4-flash", modelFamily: "deepseek",
      verifiedAt: "2026-08-20", fixtureVersion: "openai-chat-v1", capabilities: caps(), reasoning: noReasoning,
      compatibility: { state: "VERIFIED", evidenceRef: "verify-d" },
    }),
  ]),
});

/** A provider whose only candidate supports reasoning but not reasoning-with-tools. */
const withToolsMissingRegistry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    reviewedModel({
      accessProviderId: "cli", upstreamModelId: "deepseek-v4-pro", modelFamily: "deepseek",
      verifiedAt: "2026-08-20", fixtureVersion: "cli-interop-chat-v1", capabilities: caps(), reasoning: reasoningOnly,
      compatibility: { state: "VERIFIED", evidenceRef: "verify-3" },
    }),
  ]),
});

/** A registry whose only candidate is BROKEN. */
const brokenOnlyRegistry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    reviewedModel({
      accessProviderId: "cli", upstreamModelId: "broken-claims", modelFamily: "openai/codex",
      verifiedAt: "2026-08-20", fixtureVersion: "cli-interop-chat-v1", capabilities: caps(),
      compatibility: { state: "BROKEN", baseline: "claude-code-2.1.229", evidenceRef: "canary-9", checkedAt: "2026-08-21" },
    }),
  ]),
});

function expectFailure(input: ModelSelectionInput, code: string, registry = aggregatorRegistry): void {
  try {
    selectModel(input, registry);
    expect.unreachable("expected a ModelSelectionError");
  } catch (error) {
    expect(error).toBeInstanceOf(ModelSelectionError);
    expect((error as ModelSelectionError).code).toBe(code);
  }
}

describe("model capability selection engine (#68)", () => {
  it("selects the single eligible candidate for a provider", () => {
    const result = selectModel({ accessProviderId: "cli", requiredCapabilities: [] }, aggregatorRegistry);
    expect(result.model.logicalId).toBe("cli/gpt-5.6-terra");
    expect(result.decision.source).toBe("candidates");
    expect(result.decision.reason).toBe("capability-and-compatibility-match");
    expect(result.decision.selectedLogicalId).toBe("cli/gpt-5.6-terra");
  });

  it("prefers the explicit exact model pin without rerouting", () => {
    const result = selectModel(
      { accessProviderId: "cli", exactModelId: "claude-sonnet-4-5", requiredCapabilities: [] },
      aggregatorRegistry,
    );
    expect(result.model.logicalId).toBe("cli/claude-sonnet-4-5");
    expect(result.decision.source).toBe("exact");
    expect(result.decision.reason).toBe("exact-evidence");
    expect(result.decision.candidates).toHaveLength(1);
    expect(result.decision.candidates[0]?.selected).toBe(true);
  });

  it("is deterministic: identical inputs select the same model and reason", () => {
    const input: ModelSelectionInput = { accessProviderId: "cli", requiredCapabilities: ["streaming", "tools"] };
    const first = selectModel(input, aggregatorRegistry);
    const second = selectModel(input, aggregatorRegistry);
    expect(first.model.logicalId).toBe(second.model.logicalId);
    expect(first.decision).toEqual(second.decision);
    // Stable document-order tie-break: first VERIFIED candidate wins.
    expect(first.model.logicalId).toBe("cli/gpt-5.6-terra");
  });

  it("keeps the same upstream model reachable through two providers provider-scoped", () => {
    const viaCodex = selectModel(
      { accessProviderId: "codex", exactModelId: "gpt-5.4", requiredCapabilities: [] },
      sharedUpstreamRegistry,
    );
    expect(viaCodex.model.logicalId).toBe("codex/gpt-5.4");
    const viaOpenRouter = selectModel(
      { accessProviderId: "openrouter", exactModelId: "gpt-5.4", requiredCapabilities: [] },
      sharedUpstreamRegistry,
    );
    expect(viaOpenRouter.model.logicalId).toBe("openrouter/gpt-5.4");
    // Cross-provider exact lookup fails closed.
    expectFailure(
      { accessProviderId: "cline", exactModelId: "gpt-5.4", requiredCapabilities: [] },
      "unknown-exact-model",
      sharedUpstreamRegistry,
    );
  });

  it("filters candidates by preferred family on an aggregator", () => {
    const result = selectModel(
      { accessProviderId: "cli", preferredFamily: "anthropic", requiredCapabilities: [] },
      aggregatorRegistry,
    );
    expect(result.model.logicalId).toBe("cli/claude-sonnet-4-5");
    expect(result.decision.reason).toBe("family-capability-and-compatibility-match");
    expect(result.decision.candidates).toHaveLength(1);
    // Family with no evidence fails closed with an actionable reason.
    expectFailure(
      { accessProviderId: "cli", preferredFamily: "mistral", requiredCapabilities: [] },
      "no-eligible-candidate",
    );
  });

  it("rejects candidates that lack a required protocol capability", () => {
    expectFailure(
      { accessProviderId: "cli", exactModelId: "deepseek-v4-pro", requiredCapabilities: ["tools"] },
      "capability-unsupported",
    );
    // The trace records exactly which requirements a candidate misses even when
    // another candidate is selected.
    const trace = selectModel(
      { accessProviderId: "cli", requiredCapabilities: ["tools"] },
      aggregatorRegistry,
    );
    expect(trace.model.logicalId).toBe("cli/gpt-5.6-terra");
    expect(trace.decision.candidates.find((candidate) => candidate.logicalId === "cli/deepseek-v4-pro")?.missingCapabilities).toEqual(["tools"]);
  });

  it("rejects unsupported reasoning intent without downgrading", () => {
    expectFailure(
      { accessProviderId: "deepseek", requiredCapabilities: [], reasoning: { required: true } },
      "reasoning-unsupported",
      noReasoningRegistry,
    );
    expectFailure(
      { accessProviderId: "deepseek", requiredCapabilities: [], reasoning: { required: true, withTools: true } },
      "reasoning-unsupported",
      noReasoningRegistry,
    );
    // cli/deepseek-v4-pro supports reasoning but not reasoning-with-tools.
    expectFailure(
      { accessProviderId: "cli", requiredCapabilities: [], reasoning: { required: true, withTools: true } },
      "reasoning-unsupported",
      withToolsMissingRegistry,
    );
    // cli/gpt-5.6-terra carries reasoning-with-tools evidence.
    const result = selectModel(
      { accessProviderId: "cli", requiredCapabilities: [], reasoning: { required: true, withTools: true } },
      aggregatorRegistry,
    );
    expect(result.model.logicalId).toBe("cli/gpt-5.6-terra");
  });

  it("rejects BROKEN models on every path", () => {
    expectFailure(
      { accessProviderId: "cli", requiredCapabilities: [] },
      "compatibility-rejected",
      brokenOnlyRegistry,
    );
    expectFailure(
      { accessProviderId: "cli", exactModelId: "broken-claims", requiredCapabilities: [] },
      "compatibility-rejected",
    );
    expectFailure(
      { accessProviderId: "cli", exactModelId: "broken-claims", requiredCapabilities: [], allowExperimental: true },
      "compatibility-rejected",
    );
  });

  it("rejects EXPERIMENTAL candidates under the default normal-user policy", () => {
    // cli/gpt-5.6-terra and claude-sonnet-4-5 are VERIFIED; gpt-5.4 is EXPERIMENTAL.
    const result = selectModel({ accessProviderId: "cli", requiredCapabilities: [] }, aggregatorRegistry);
    expect(result.model.compatibility.state).toBe("VERIFIED");
    const selected = result.decision.candidates.find((candidate) => candidate.selected);
    expect(selected?.compatibilityPass).toBe(true);
    expect(selected?.compatibilityState).toBe("VERIFIED");
    expect(result.decision.candidates.find((candidate) => candidate.logicalId === "cli/gpt-5.4")?.compatibilityFailure).toBe("experimental");
  });

  it("accepts EXPERIMENTAL candidates only with an explicit opt-in", () => {
    const without = selectModel({ accessProviderId: "cli", requiredCapabilities: [] }, aggregatorRegistry);
    expect(without.model.logicalId).toBe("cli/gpt-5.6-terra");
    const withOptIn = selectModel(
      { accessProviderId: "cli", requiredCapabilities: [], allowExperimental: true },
      aggregatorRegistry,
    );
    expect(withOptIn.model.logicalId).toBe("cli/gpt-5.6-terra");
    // EXPERIMENTAL-only registry: candidate path fails closed by default...
    const experimentalOnly: RegistryDocument = Object.freeze({
      registryRevision: MODEL_REGISTRY_REVISION,
      models: Object.freeze([
        reviewedModel({
          accessProviderId: "cli", upstreamModelId: "gpt-5.4", modelFamily: "openai/codex",
          verifiedAt: "2026-08-20", fixtureVersion: "f1", capabilities: caps(),
        }),
      ]),
    });
    expectFailure({ accessProviderId: "cli", requiredCapabilities: [] }, "compatibility-rejected", experimentalOnly);
    // ...and an explicit pin is itself an explicit opt-in for that exact model.
    const pinned = selectModel(
      { accessProviderId: "cli", exactModelId: "gpt-5.4", requiredCapabilities: [] },
      experimentalOnly,
    );
    expect(pinned.model.compatibility.state).toBe("EXPERIMENTAL");
    expect(pinned.decision.source).toBe("exact");
  });

  it("fails closed on missing evidence and unknown providers", () => {
    expectFailure(
      { accessProviderId: "unknown-provider", requiredCapabilities: [] },
      "no-trusted-evidence",
    );
    expectFailure(
      { accessProviderId: "cli", exactModelId: "not-reviewed", requiredCapabilities: [] },
      "unknown-exact-model",
    );
  });

  it("exposes the typed failure taxonomy codes", () => {
    expectFailure({ accessProviderId: "cli", exactModelId: "gpt-unreviewed", requiredCapabilities: [] }, "unknown-exact-model");
    expectFailure({ accessProviderId: "ghost", requiredCapabilities: [] }, "no-trusted-evidence");
    expectFailure({ accessProviderId: "cli", requiredCapabilities: ["images"] }, "capability-unsupported");
    expectFailure({ accessProviderId: "deepseek", requiredCapabilities: [], reasoning: { required: true, withTools: true } }, "reasoning-unsupported", noReasoningRegistry);
    expectFailure({ accessProviderId: "cli", exactModelId: "broken-claims", requiredCapabilities: [] }, "compatibility-rejected");
    expectFailure({ accessProviderId: "cli", preferredFamily: "mistral", requiredCapabilities: [] }, "no-eligible-candidate");
  });

  it("records a frozen, secret-free decision trace with allowlisted metadata only", () => {
    const result = selectModel(
      { accessProviderId: "cli", exactModelId: "claude-sonnet-4-5", requiredCapabilities: [] },
      aggregatorRegistry,
    );
    expect(Object.isFrozen(result.decision)).toBe(true);
    expect(Object.isFrozen(result.decision.candidates)).toBe(true);
    expect(Object.isFrozen(result.decision.candidates[0])).toBe(true);
    // Flattened allowlisted keys: no `identity`, no credential/account fields.
    const trace = result.decision as unknown as Record<string, unknown>;
    expect(Object.keys(trace)).toEqual(["source", "selectedLogicalId", "reason", "candidates"]);
    const candidate = result.decision.candidates[0] as unknown as Record<string, unknown>;
    expect(Object.keys(candidate)).toEqual([
      "logicalId", "accessProviderId", "modelId", "modelFamily", "compatibilityState",
      "capabilityPass", "reasoningPass", "compatibilityPass", "selected",
    ]);
    const forbidden = new Set(["identity", "accessToken", "refreshToken", "authorization", "token", "secret", "password", "email", "prompt", "response", "pseudonym", "credentialHandle", "accountId"]);
    const walk = (value: unknown, path: string): string[] => {
      if (value === null || typeof value !== "object") return [];
      const findings: string[] = [];
      for (const [key, child] of Object.entries(value)) {
        if (forbidden.has(key)) findings.push(`${path}.${key}`);
        findings.push(...walk(child, `${path}.${key}`));
      }
      return findings;
    };
    expect(walk(result.decision, "decision")).toEqual([]);
  });
});
