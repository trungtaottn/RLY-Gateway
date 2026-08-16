import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSecretFree } from "../../src/control-plane/secret-free.js";
import { RLY_MODEL_PREFIX } from "../../src/routing/model-projection/types.js";
import { PRECEDENCE_ORDER } from "../../src/routing/model-decision/types.js";
import type { EffectiveModelDecisionInput } from "../../src/routing/model-decision/types.js";
import {
  assembleEffectiveModelDecision,
  blockedAlternativesFor,
  detectConflicts,
  environmentOwnershipSummary,
  precedenceSourceForIntent,
  precedenceWinnerFor,
  readPersistedViewModel,
} from "../../src/routing/model-decision/assemble.js";
import { describeModelDecision } from "../../src/routing/model-decision/describe.js";

/**
 * W3-T3 EffectiveModelDecision control plane (#127) — unit coverage.
 *
 * The assembler is a PURE recorder of existing stage outputs (#68/#69/#70/
 * #71/#72/#124/#125/#126); these tests prove deterministic precedence
 * bookkeeping, visible conflicts (no hidden string/env override wins), blocked
 * alternatives, ECR authority recording, persisted-view isolation, and
 * secret-free output.
 */

const BASE: EffectiveModelDecisionInput = Object.freeze({
  requestId: "req-unit-001",
  profileId: "profile-unit-1",
  profileName: "unit",
  viewId: "default",
  intent: Object.freeze({
    kind: "EXACT_CLIENT_MODEL",
    sourceSelector: "gpt-5.6-terra",
    source: "exact-model",
    modelId: "gpt-5.6-terra",
    role: "primary",
  }),
  resolvedModelId: "gpt-5.6-terra",
  logicalId: "cline/gpt-5.6-terra",
  accessProviderId: "cline",
  adapterId: "cline-interop",
  modelFamily: "openai/codex",
  poolId: "pool-unit-1",
  policyRevision: 7,
  policyHash: "b".repeat(64),
  registryRevision: 5,
  sessionUniverseRevision: 7,
  experimentalModels: false,
  reasoning: Object.freeze({
    requested: Object.freeze({ intent: "BALANCED", explicit: false }),
    canonicalIntent: "BALANCED",
    effective: Object.freeze({ kind: "binary", enabled: true }),
    mappingKind: "normalized",
  }),
  selection: Object.freeze({
    source: "exact",
    selectedLogicalId: "cline/gpt-5.6-terra",
    reason: "exact-evidence",
    candidates: Object.freeze([Object.freeze({
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
    })]),
  }),
  profileRole: "primary",
  decidedAt: "2026-08-20T00:00:00.000Z",
});

function input(overrides: Partial<EffectiveModelDecisionInput> = {}): EffectiveModelDecisionInput {
  return { ...BASE, ...overrides };
}

describe("EffectiveModelDecision assembly (#127)", () => {
  it("is deterministic: identical inputs produce identical decisions", () => {
    const first = assembleEffectiveModelDecision(input());
    const second = assembleEffectiveModelDecision(input());
    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(1);
    expect(first.requestId).toBe("req-unit-001");
  });

  it("records the frozen target, reasoning, ECR authority, pool binding, and revisions", () => {
    const decision = assembleEffectiveModelDecision(input());
    expect(decision.target).toEqual({
      accessProviderId: "cline",
      physicalModelId: "gpt-5.6-terra",
      logicalId: "cline/gpt-5.6-terra",
      modelFamily: "openai/codex",
      adapterId: "cline-interop",
    });
    expect(decision.reasoning.canonicalIntent).toBe("BALANCED");
    expect(decision.reasoning.mappingKind).toBe("normalized");
    expect(decision.compatibility).toMatchObject({
      authority: "ecr",
      selectedLogicalId: "cline/gpt-5.6-terra",
      effectiveLabel: "experimental",
      enforcementReason: "explicit-experimental-override",
      seedState: "EXPERIMENTAL",
    });
    expect(decision.poolBinding).toMatchObject({ poolId: "pool-unit-1", providerId: "cline", policyRevision: 7, experimentalModels: false });
    expect(decision.revisions).toMatchObject({ policyRevision: 7, registryRevision: 5, sessionUniverseRevision: 7 });
    expect(decision.precedence.order).toEqual(PRECEDENCE_ORDER);
    expect(decision.reasons.map((reason) => reason.code)).toContain("frozen-model-target");
    expect(decision.reasons.map((reason) => reason.code)).toContain("ecr-authority");
    expect(decision.reasons.map((reason) => reason.code)).toContain("pool-pinned");
  });

  it("maps every typed intent kind to the deterministic precedence winner", () => {
    expect(precedenceSourceForIntent("EXACT_PROJECTION")).toBe("exact-projection");
    expect(precedenceSourceForIntent("RLY_LOGICAL_TIER")).toBe("explicit-rly-tier");
    expect(precedenceSourceForIntent("CLIENT_NATIVE_ALIAS")).toBe("client-native-alias");
    expect(precedenceSourceForIntent("EXACT_CLIENT_MODEL")).toBe("exact-client-model");
    expect(precedenceSourceForIntent("INHERIT")).toBe("subagent-inherit");
    expect(precedenceSourceForIntent("DEFAULT")).toBe("profile-policy");

    // Tier + alias + projection winners carry their resolution path.
    expect(precedenceWinnerFor(input({ intent: { kind: "RLY_LOGICAL_TIER", sourceSelector: "rly-tier:fable", source: "rly-tier-namespace", tier: "fable" } })))
      .toEqual({ winner: "explicit-rly-tier", resolvedThrough: "tier-resolver" });
    expect(precedenceWinnerFor(input({ intent: { kind: "CLIENT_NATIVE_ALIAS", sourceSelector: "fable", source: "client-native-alias-contract", tier: "fable", alias: "fable" } })))
      .toEqual({ winner: "client-native-alias", resolvedThrough: "client-alias-contract" });
    expect(precedenceWinnerFor(input({ intent: { kind: "EXACT_PROJECTION", sourceSelector: "claude-rly-cline-abc123", source: "projection-namespace", modelId: "gpt-5.6-terra", role: "unknown" } })))
      .toEqual({ winner: "exact-projection", resolvedThrough: "projection-reverse-map" });

    // A selector that equals the owning view's persisted projection records
    // persisted-view provenance (never silently remapped).
    const persisted = precedenceWinnerFor(input({
      intent: { kind: "EXACT_PROJECTION", sourceSelector: "claude-rly-cline-abc123", source: "projection-namespace", modelId: "gpt-5.6-terra", role: "unknown" },
      persistedViewModel: "claude-rly-cline-abc123",
    }));
    expect(persisted).toEqual({ winner: "persisted-rly-view", resolvedThrough: "persisted-view-state" });

    // INHERIT resolves through the parent context when present, else profile default.
    expect(precedenceWinnerFor(input({
      intent: { kind: "INHERIT", sourceSelector: "inherit", source: "inherit" },
      parent: { parentModelId: "gpt-5.6-sol", contextSource: "parent-agent" },
    }))).toEqual({ winner: "subagent-inherit", resolvedThrough: "parent-context" });
    expect(precedenceWinnerFor(input({ intent: { kind: "INHERIT", sourceSelector: "inherit", source: "inherit" } })))
      .toEqual({ winner: "profile-policy", resolvedThrough: "profile-default-fallback" });

    // DEFAULT resolves through the profile's primary role (profile policy).
    expect(precedenceWinnerFor(input({ intent: { kind: "DEFAULT", sourceSelector: "default", source: "default" } })))
      .toEqual({ winner: "profile-policy", resolvedThrough: "profile-default-role" });
  });

  it("records alias provenance and inherit provenance", () => {
    const alias = assembleEffectiveModelDecision(input({
      intent: { kind: "CLIENT_NATIVE_ALIAS", sourceSelector: "fable", source: "client-native-alias-contract", tier: "fable", alias: "fable" },
      clientAlias: { alias: "fable", mappedTier: "fable" },
      tier: Object.freeze({
        requestedTier: "fable",
        accessProviderId: "cline",
        modelFamily: "openai/codex",
        mappingSource: "derived",
        selectedLogicalId: "cline/gpt-5.6-sol",
        reason: "derived-tier-target",
        mappingRevision: 3,
        registryRevision: 5,
      }),
    }));
    expect(alias.provenance.clientAlias).toEqual({ alias: "fable", mappedTier: "fable" });
    expect(alias.provenance.tier?.requestedTier).toBe("fable");
    expect(alias.precedence.winner).toBe("client-native-alias");
    expect(alias.provenance.defaulted).toBe(false);

    const inherited = assembleEffectiveModelDecision(input({
      intent: { kind: "INHERIT", sourceSelector: "inherit", source: "inherit" },
      parent: { parentModelId: "gpt-5.6-sol", parentModelFamily: "openai/codex", contextSource: "parent-agent" },
    }));
    expect(inherited.provenance.inherit).toEqual({
      parentModelId: "gpt-5.6-sol",
      parentModelFamily: "openai/codex",
      contextSource: "parent-agent",
    });
    expect(inherited.precedence.winner).toBe("subagent-inherit");
    expect(inherited.reasons.map((reason) => reason.code)).toContain("parent-context-inherited");
  });

  it("detects deterministic conflicts and never lets a hidden source win silently", () => {
    // Persisted view model differs from the request selector.
    const persistedConflict = detectConflicts(input({
      persistedViewModel: "claude-rly-cline-aaa111",
      launchPolicyModel: "gpt-5.6-sol",
    }));
    expect(persistedConflict.some((conflict) => conflict.kind === "persisted-view-model-vs-request")).toBe(true);
    expect(persistedConflict.some((conflict) => conflict.kind === "launch-policy-vs-request")).toBe(true);
    expect(persistedConflict.some((conflict) => conflict.kind === "gateway-contract-env-present")).toBe(false);

    // A foreign/stale projection id is visible as projection-vs-view-state.
    const projectionConflict = detectConflicts(input({
      intent: { kind: "EXACT_PROJECTION", sourceSelector: "claude-rly-cline-zzz999", source: "projection-namespace", modelId: "gpt-5.6-sol", role: "unknown" },
      persistedViewModel: "claude-rly-cline-aaa111",
    }));
    expect(projectionConflict.some((conflict) => conflict.kind === "projection-vs-view-state")).toBe(true);

    // Subagent explicit selection vs frozen parent context is visible; the
    // child's intent wins and the parent is not mutated.
    const subagentConflict = detectConflicts(input({
      intent: { kind: "EXACT_CLIENT_MODEL", sourceSelector: "gpt-5.6-terra", source: "exact-model", modelId: "gpt-5.6-terra", role: "primary" },
      parent: { parentModelId: "gpt-5.6-sol", contextSource: "parent-agent" },
    }));
    expect(subagentConflict.some((conflict) => conflict.kind === "subagent-request-vs-parent-context")).toBe(true);

    // Gateway-contract env keys are RLY-owned and recorded as consumed state.
    const envConflict = detectConflicts(input({
      environmentOwnership: environmentOwnershipSummary({ ANTHROPIC_BASE_URL: "http://127.0.0.1:17871" }),
    }));
    expect(envConflict.some((conflict) => conflict.kind === "gateway-contract-env-present")).toBe(true);

    // Deterministic order: identical inputs produce identical conflict arrays.
    expect(detectConflicts(input({ persistedViewModel: "claude-rly-cline-aaa111", launchPolicyModel: "gpt-5.6-sol" })))
      .toEqual(persistedConflict);
  });

  it("surfaces blocked alternatives with typed failure reasons from #68 assessments", () => {
    const selection = {
      source: "exact" as const,
      selectedLogicalId: "cline/gpt-5.6-terra",
      reason: "exact-evidence",
      candidates: [
        { logicalId: "cline/gpt-5.6-terra", accessProviderId: "cline", modelId: "gpt-5.6-terra", compatibilityState: "VERIFIED" as const, capabilityPass: true, reasoningPass: true, compatibilityPass: true, selected: true },
        { logicalId: "cline/gpt-5.6-sol", accessProviderId: "cline", modelId: "gpt-5.6-sol", modelFamily: "openai/codex", compatibilityState: "BROKEN" as const, capabilityPass: true, reasoningPass: true, compatibilityPass: false, compatibilityFailure: "broken", selected: false },
        { logicalId: "cline/gpt-5.6-flash", accessProviderId: "cline", modelId: "gpt-5.6-flash", compatibilityState: "VERIFIED" as const, capabilityPass: false, missingCapabilities: ["tools"], reasoningPass: true, compatibilityPass: true, selected: false },
        { logicalId: "cline/gpt-5.6-tiny", accessProviderId: "cline", modelId: "gpt-5.6-tiny", compatibilityState: "VERIFIED" as const, capabilityPass: true, reasoningPass: false, reasoningFailure: "reasoning-not-supported", compatibilityPass: true, selected: false },
      ],
    };
    const blocked = blockedAlternativesFor(selection as unknown as Parameters<typeof blockedAlternativesFor>[0]);
    expect(blocked).toHaveLength(3);
    expect(blocked.find((item) => item.logicalId === "cline/gpt-5.6-sol")?.blockedBy).toEqual(["compatibility-rejected"]);
    expect(blocked.find((item) => item.logicalId === "cline/gpt-5.6-flash")?.blockedBy).toEqual(["capability-unsupported"]);
    expect(blocked.find((item) => item.logicalId === "cline/gpt-5.6-tiny")?.blockedBy).toEqual(["reasoning-unsupported"]);

    const decision = assembleEffectiveModelDecision(input({ selection: selection as unknown as EffectiveModelDecisionInput["selection"] }));
    expect(decision.blockedAlternatives).toHaveLength(3);
    expect(decision.blockedAlternatives[0]?.blockedBy[0]).toBe("compatibility-rejected");
  });

  it("records per-feature ECR answers for the selected model", () => {
    const decision = assembleEffectiveModelDecision(input({
      effectiveFeatures: Object.freeze({
        text: Object.freeze({ effective: "experimental", enforcement: "experimental-override" }),
        streaming: Object.freeze({ effective: "experimental", enforcement: "experimental-override" }),
      }),
    }));
    expect(decision.compatibility.features).toEqual({
      text: { effective: "experimental", enforcement: "experimental-override" },
      streaming: { effective: "experimental", enforcement: "experimental-override" },
    });
  });

  it("classifies env ownership with RLY gateway contract keys as rly-owned", () => {
    const summary = environmentOwnershipSummary({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:17871",
      ANTHROPIC_AUTH_TOKEN: "fixture-token",
      OPENAI_API_KEY: "fixture-key",
      RLY_PROFILE: "unit",
      HOME: "/tmp",
    });
    expect(summary.rlyOwned).toBe(3);
    expect(summary.gatewayEnvKeys).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"]);
    expect(summary.safePassThrough).toBe(1);
    expect(summary.conflicting).toEqual([]);
  });

  it("reads only the OWNING view's persisted RLY projection model (view isolation)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-model-decision-view-"));
    try {
      const viewA = join(directory, "claude", "views", "view-a");
      await mkdir(viewA, { recursive: true });
      await writeFile(join(viewA, "settings.json"), JSON.stringify({
        model: `${RLY_MODEL_PREFIX}cline-aaa111`,
        env: { OPENAI_API_KEY: "native-key" },
      }), "utf8");
      const viewB = join(directory, "claude", "views", "view-b");
      await mkdir(viewB, { recursive: true });
      await writeFile(join(viewB, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5" }), "utf8");

      // Owning view exposes its RLY-owned persisted projection id.
      await expect(readPersistedViewModel(directory, "view-a")).resolves.toBe(`${RLY_MODEL_PREFIX}cline-aaa111`);
      // A non-RLY model in a view is not RLY-owned persisted state.
      await expect(readPersistedViewModel(directory, "view-b")).resolves.toBeUndefined();
      // Another profile's view never leaks into a foreign view read.
      await expect(readPersistedViewModel(directory, "view-b")).resolves.not.toBe(`${RLY_MODEL_PREFIX}cline-aaa111`);
      // Missing/unreadable view is fail-open (decision still produced).
      await expect(readPersistedViewModel(directory, "no-such-view")).resolves.toBeUndefined();
      await expect(readPersistedViewModel(undefined, "default")).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps decisions and descriptions secret-free (allowlisted metadata only)", () => {
    const decision = assembleEffectiveModelDecision(input({
      environmentOwnership: environmentOwnershipSummary({ ANTHROPIC_AUTH_TOKEN: "fixture-token" }),
      persistedViewModel: `${RLY_MODEL_PREFIX}cline-aaa111`,
      launchPolicyModel: "gpt-5.6-sol",
    }));
    expect(() => assertSecretFree(decision)).not.toThrow();
    const described = describeModelDecision(decision);
    expect(() => assertSecretFree(described)).not.toThrow();
    const serialized = JSON.stringify(described);
    expect(serialized).not.toMatch(/access-token|refresh-token|authorization|prompt|response|@|api[_-]?key/i);
    expect(serialized).not.toMatch(/fixture-token/);
    // Decision output is metadata: no prompts, reasoning text, or credentials.
    expect(JSON.stringify(decision)).not.toMatch(/prompt|response|reasoning text|authorization/i);
  });

  it("records stable reasons for every stage consumed", () => {
    const decision = assembleEffectiveModelDecision(input({
      tier: Object.freeze({
        requestedTier: "fable",
        accessProviderId: "cline",
        mappingSource: "reviewed-mapping",
        selectedLogicalId: "cline/gpt-5.6-sol",
        reason: "reviewed-tier-mapping",
        mappingRevision: 3,
        registryRevision: 5,
      }),
      projection: Object.freeze({
        projectionId: "claude-rly-cline-abc123",
        displayName: "Sol (ClinePass)",
        providerId: "cline",
        upstreamModelId: "gpt-5.6-sol",
        poolId: "pool-unit-1",
        policyRevision: 7,
        registryRevision: 5,
      }),
      persistedViewModel: "claude-rly-cline-abc123",
      environmentOwnership: environmentOwnershipSummary({ ANTHROPIC_BASE_URL: "http://127.0.0.1:17871" }),
    }));
    const codes = decision.reasons.map((reason) => reason.code);
    expect(codes).toContain("intent-resolved");
    expect(codes).toContain("tier-resolved");
    expect(codes).toContain("projection-reverse-mapped");
    expect(codes).toContain("reasoning-mapped");
    expect(codes).toContain("persisted-view-state");
    expect(codes).toContain("env-ownership");
    expect(codes).toContain("ecr-authority");
    expect(decision.reasons.every((reason) => reason.code.length > 0 && reason.detail.length > 0)).toBe(true);
  });
});
