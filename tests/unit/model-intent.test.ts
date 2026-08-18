import { describe, expect, it } from "vitest";
import { classifyModelIntent, parseRlyTierSelector } from "../../src/routing/model-intent/classify.js";
import { isModelIntentError, ModelIntentError } from "../../src/routing/model-intent/errors.js";
import {
  CLIENT_NATIVE_ALIASES,
  MODEL_INTENT_KINDS,
  RLY_TIER_NAMESPACE,
  type ModelIntent,
  type ModelIntentTrace,
} from "../../src/routing/model-intent/types.js";
import { isLogicalTier } from "../../src/routing/model-tiers/types.js";

describe("model-intent selector namespaces (#125)", () => {
  it("keeps the core invariant: a bare alias and the explicit RLY selector are different intent kinds", () => {
    const bare = classifyModelIntent("fable");
    const explicit = classifyModelIntent("rly-tier:fable");
    expect(bare.kind).toBe("CLIENT_NATIVE_ALIAS");
    expect(explicit.kind).toBe("RLY_LOGICAL_TIER");
    expect(bare.kind).not.toBe(explicit.kind);
    // Provenance is preserved exactly for diagnostics.
    expect(bare.sourceSelector).toBe("fable");
    expect(bare.source).toBe("client-native-alias-contract");
    expect(explicit.sourceSelector).toBe("rly-tier:fable");
    expect(explicit.source).toBe("rly-tier-namespace");
  });

  it("classifies every RLY logical tier selector into the explicit namespace", () => {
    for (const tier of ["haiku", "sonnet", "opus", "fable"] as const) {
      const intent = classifyModelIntent(`${RLY_TIER_NAMESPACE}${tier}`);
      expect(intent.kind).toBe("RLY_LOGICAL_TIER");
      if (intent.kind !== "RLY_LOGICAL_TIER") throw new Error("unreachable");
      expect(intent.tier).toBe(tier);
      expect(isLogicalTier(intent.tier)).toBe(true);
      expect(parseRlyTierSelector(`rly-tier:${tier}`)).toBe(tier);
    }
  });

  it("fails closed with unknown-namespace for an invalid rly-tier: selector", () => {
    for (const selector of ["rly-tier:gpt-5.6-sol", "rly-tier:", "rly-tier:claude-sonnet-4-5", "rly-tier:primary", "rly-tier:rly-tier:fable"]) {
      try {
        classifyModelIntent(selector);
        expect.unreachable(`expected a ModelIntentError for ${selector}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ModelIntentError);
        expect(isModelIntentError(error)).toBe(true);
        expect((error as ModelIntentError).code).toBe("unknown-namespace");
      }
    }
  });

  it("classifies bare client-native aliases only through the explicit alias contract", () => {
    expect(CLIENT_NATIVE_ALIASES).toEqual(["haiku", "sonnet", "opus", "fable"]);
    for (const alias of CLIENT_NATIVE_ALIASES) {
      const intent = classifyModelIntent(alias);
      expect(intent.kind).toBe("CLIENT_NATIVE_ALIAS");
      if (intent.kind !== "CLIENT_NATIVE_ALIAS") throw new Error("unreachable");
      expect(intent.alias).toBe(alias);
      expect(intent.mappedTier).toBe(alias); // deliberate, traceable mapping — not string equality routing
      expect(intent.source).toBe("client-native-alias-contract");
    }
  });

  it("classifies RLY projection ids as EXACT_PROJECTION and never as a tier/alias", () => {
    for (const selector of ["claude-rly-cline-abc123", "claude-rly-haiku", "claude-rly-anthropic-xyz"]) {
      const intent = classifyModelIntent(selector);
      expect(intent.kind).toBe("EXACT_PROJECTION");
      if (intent.kind !== "EXACT_PROJECTION") throw new Error("unreachable");
      expect(intent.projectionId).toBe(selector);
      expect(intent.source).toBe("projection-namespace");
    }
  });

  it("classifies inherit/default selectors", () => {
    const inherit = classifyModelIntent("inherit");
    expect(inherit.kind).toBe("INHERIT");
    if (inherit.kind !== "INHERIT") throw new Error("unreachable");
    expect(inherit.source).toBe("inherit");
    for (const selector of ["", "default"]) {
      const intent = classifyModelIntent(selector);
      expect(intent.kind).toBe("DEFAULT");
      if (intent.kind !== "DEFAULT") throw new Error("unreachable");
      expect(intent.source).toBe("default");
      expect(intent.sourceSelector).toBe(selector);
    }
  });

  it("classifies anything else as an exact client model id (never a tier)", () => {
    // Persisted exact model ids and profile roles must never be reinterpreted
    // as logical tiers even when they share a name with an alias family.
    for (const selector of ["gpt-5.6-sol", "gpt-5.6-terra", "claude-sonnet-4-5", "claude-opus-4-8", "primary", "fast", "deepseek-v4-pro", "claude-fable"]) {
      const intent = classifyModelIntent(selector);
      expect(intent.kind).toBe("EXACT_CLIENT_MODEL");
      if (intent.kind !== "EXACT_CLIENT_MODEL") throw new Error("unreachable");
      expect(intent.modelId).toBe(selector);
      expect(intent.source).toBe("exact-model");
    }
  });

  it("applies deterministic precedence: rly-tier: > projection > alias > inherit/default > exact model", () => {
    // 1. rly-tier: wins over any other interpretation.
    expect(classifyModelIntent("rly-tier:haiku").kind).toBe("RLY_LOGICAL_TIER");
    // 2. projection namespace wins over the alias vocabulary.
    expect(classifyModelIntent("claude-rly-haiku").kind).toBe("EXACT_PROJECTION");
    // 3. bare alias vocabulary wins over the exact-model catch-all.
    expect(classifyModelIntent("fable").kind).toBe("CLIENT_NATIVE_ALIAS");
    // 4. inherit/default beat the catch-all.
    expect(classifyModelIntent("inherit").kind).toBe("INHERIT");
    expect(classifyModelIntent("default").kind).toBe("DEFAULT");
    // 5. everything else is an exact client model.
    expect(classifyModelIntent("claude-sonnet-4-5").kind).toBe("EXACT_CLIENT_MODEL");
    // Determinism: identical inputs classify identically every time.
    const first = classifyModelIntent("rly-tier:fable");
    const second = classifyModelIntent("rly-tier:fable");
    expect(first).toEqual(second);
  });

  it("exposes a fixed typed intent-kind vocabulary", () => {
    expect(MODEL_INTENT_KINDS).toEqual([
      "EXACT_PROJECTION",
      "RLY_LOGICAL_TIER",
      "CLIENT_NATIVE_ALIAS",
      "EXACT_CLIENT_MODEL",
      "INHERIT",
      "DEFAULT",
    ]);
  });
});

describe("model-intent trace privacy (#125)", () => {
  it("produces frozen, allowlisted, secret-free intent metadata for every kind", () => {
    const cases: readonly ModelIntent[] = [
      classifyModelIntent("rly-tier:fable"),
      classifyModelIntent("fable"),
      classifyModelIntent("claude-rly-cline-abc123"),
      classifyModelIntent("gpt-5.6-terra"),
      classifyModelIntent("inherit"),
      classifyModelIntent("default"),
    ];
    for (const intent of cases) {
      const trace: ModelIntentTrace = Object.freeze({
        kind: intent.kind,
        sourceSelector: intent.sourceSelector,
        source: intent.source,
      });
      expect(Object.isFrozen(trace)).toBe(true);
      const forbidden = new Set(["prompt", "response", "credential", "token", "secret", "password", "email", "accountId", "authorization", "apiKey"]);
      const walk = (value: unknown, path: string): string[] => {
        if (value === null || typeof value !== "object") return [];
        const findings: string[] = [];
        for (const [key, child] of Object.entries(value)) {
          if (forbidden.has(key)) findings.push(`${path}.${key}`);
          findings.push(...walk(child, `${path}.${key}`));
        }
        return findings;
      };
      expect(walk(trace, "trace")).toEqual([]);
    }
  });
});
