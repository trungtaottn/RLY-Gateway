import { describe, expect, it } from "vitest";
import type { ReasoningCapabilityEvidence } from "../../src/core/capabilities.js";
import type { ReasoningRequest } from "../../src/core/reasoning.js";
import { ReasoningTranslationError, resolveReasoning } from "../../src/providers/reasoning.js";

/** Six-level GPT-5.6-family shape: none/low/medium/high/xhigh/max. */
const sixLevel: ReasoningCapabilityEvidence = Object.freeze({
  supported: true, controlKind: "discrete-effort",
  effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],
  adaptive: false, tokenBudget: false, reasoningWithTools: true,
});

/** Two-level discrete target: low/high. */
const twoLevel: ReasoningCapabilityEvidence = Object.freeze({
  supported: true, controlKind: "discrete-effort",
  effortLevels: ["low", "high"],
  adaptive: false, tokenBudget: false, reasoningWithTools: true,
});

const binary: ReasoningCapabilityEvidence = Object.freeze({
  supported: true, controlKind: "binary", adaptive: false, tokenBudget: false, reasoningWithTools: true,
});

const adaptive: ReasoningCapabilityEvidence = Object.freeze({
  supported: true, controlKind: "adaptive", adaptive: true, tokenBudget: false, reasoningWithTools: true,
});

const unsupported: ReasoningCapabilityEvidence = Object.freeze({
  supported: false, controlKind: "none", adaptive: false, tokenBudget: false, reasoningWithTools: false,
});

const budget: ReasoningCapabilityEvidence = Object.freeze({
  supported: true, controlKind: "token-budget", adaptive: false, tokenBudget: true, reasoningWithTools: true,
});

const budgetPolicy = Object.freeze({ economy: 512, balanced: 2048, deep: 8192, maximum: 16_384 });

function req(partial: Partial<ReasoningRequest>): ReasoningRequest {
  return Object.freeze({ intent: "AUTO", explicit: false, ...partial });
}

describe("provider reasoning translation boundary (#70)", () => {
  it("maps OFF to an explicit off control on every control kind", () => {
    for (const capability of [sixLevel, twoLevel, binary, adaptive, budget, unsupported]) {
      const resolved = resolveReasoning(req({ intent: "OFF", explicit: true }), capability);
      expect(resolved.effective).toEqual({ kind: "off" });
      expect(resolved.mappingKind).toBe("exact");
      expect(resolved.canonicalIntent).toBe("OFF");
    }
  });

  it("delegates AUTO (no explicit intent) to the provider default", () => {
    const resolved = resolveReasoning(req({ intent: "AUTO", explicit: false }), sixLevel);
    expect(resolved.effective).toEqual({ kind: "provider-default" });
    expect(resolved.mappingKind).toBe("default");
  });

  it("preserves exact same-family source effort on a discrete target", () => {
    const resolved = resolveReasoning(req({ intent: "MAXIMUM", sourceEffort: "xhigh", explicit: true }), sixLevel);
    expect(resolved.effective).toEqual({ kind: "effort", level: "xhigh" });
    expect(resolved.mappingKind).toBe("exact");
    expect(resolved.fallbackReason).toBeUndefined();
  });

  it("maps semantic intents to nearest native levels on a 6-level target", () => {
    // usable levels are low/medium/high/xhigh/max ("none" is off-only); the
    // deterministic midpoint of 5 usable levels is high.
    expect(resolveReasoning(req({ intent: "ECONOMY", explicit: true }), sixLevel).effective).toEqual({ kind: "effort", level: "low" });
    expect(resolveReasoning(req({ intent: "BALANCED", explicit: true }), sixLevel).effective).toEqual({ kind: "effort", level: "high" });
    expect(resolveReasoning(req({ intent: "DEEP", explicit: true }), sixLevel).effective).toEqual({ kind: "effort", level: "xhigh" });
    expect(resolveReasoning(req({ intent: "MAXIMUM", explicit: true }), sixLevel).effective).toEqual({ kind: "effort", level: "max" });
    for (const intent of ["ECONOMY", "BALANCED", "DEEP", "MAXIMUM"] as const) {
      expect(resolveReasoning(req({ intent, explicit: true }), sixLevel).mappingKind).toBe("normalized");
      expect(resolveReasoning(req({ intent, explicit: true }), sixLevel).fallbackReason).toMatch(intent);
    }
  });

  it("maps a 2-level target deterministically and records the lossy mapping", () => {
    expect(resolveReasoning(req({ intent: "ECONOMY", explicit: true }), twoLevel).effective).toEqual({ kind: "effort", level: "low" });
    expect(resolveReasoning(req({ intent: "MAXIMUM", explicit: true }), twoLevel).effective).toEqual({ kind: "effort", level: "high" });
    // DEEP collapses onto the deepest tier (high) because no distinct deep
    // tier exists; the lossy mapping is recorded, never silent.
    const deep = resolveReasoning(req({ intent: "DEEP", explicit: true }), twoLevel);
    expect(deep.effective).toEqual({ kind: "effort", level: "high" });
    expect(deep.mappingKind).toBe("normalized");
    expect(deep.fallbackReason).toMatch(/DEEP mapped to native level high/);
  });

  it("normalizes an unsupported source effort instead of pretending equivalence", () => {
    const resolved = resolveReasoning(req({ intent: "MAXIMUM", sourceEffort: "xhigh", explicit: true }), twoLevel);
    expect(resolved.effective).toEqual({ kind: "effort", level: "high" });
    expect(resolved.mappingKind).toBe("normalized");
    expect(resolved.fallbackReason).toMatch(/source effort xhigh is not natively supported/);
  });

  it("never collapses binary and adaptive into one silent boolean", () => {
    const binaryResolved = resolveReasoning(req({ intent: "DEEP", explicit: true }), binary);
    expect(binaryResolved.effective).toEqual({ kind: "binary", enabled: true });
    expect(binaryResolved.mappingKind).toBe("downgraded");
    expect(binaryResolved.fallbackReason).toMatch(/binary reasoning control has no effort granularity/);

    const adaptiveResolved = resolveReasoning(req({ intent: "DEEP", explicit: true }), adaptive);
    expect(adaptiveResolved.effective).toEqual({ kind: "adaptive", enabled: true });
    expect(adaptiveResolved.mappingKind).toBe("normalized");
    expect(adaptiveResolved.fallbackReason).toMatch(/adaptive reasoning control has no effort granularity/);
  });

  it("honors an adaptive source mode exactly on an adaptive control", () => {
    const resolved = resolveReasoning(req({ intent: "AUTO", sourceMode: "adaptive", explicit: true }), adaptive);
    expect(resolved.effective).toEqual({ kind: "adaptive", enabled: true });
    expect(resolved.mappingKind).toBe("exact");
  });

  it("realizes an adaptive source mode on a non-adaptive control with a recorded reason", () => {
    const resolved = resolveReasoning(req({ intent: "AUTO", sourceMode: "adaptive", explicit: true }), binary);
    expect(resolved.effective).toEqual({ kind: "binary", enabled: true });
    expect(resolved.mappingKind).toBe("normalized");
    expect(resolved.fallbackReason).toMatch(/adaptive source mode has no adaptive control/);
  });

  it("fails closed on unsupported reasoning for explicit intents", () => {
    for (const intent of ["ECONOMY", "BALANCED", "DEEP", "MAXIMUM"] as const) {
      try {
        resolveReasoning(req({ intent, explicit: true }), unsupported);
        expect.unreachable("expected unsupported-reasoning");
      } catch (error) {
        expect(error).toBeInstanceOf(ReasoningTranslationError);
        expect((error as ReasoningTranslationError).code).toBe("unsupported-reasoning");
        expect((error as Error).message).toContain(intent);
      }
    }
  });

  it("downgrades unsupported reasoning only under an explicit best-effort policy", () => {
    const resolved = resolveReasoning(req({ intent: "MAXIMUM", explicit: true }), unsupported, { bestEffort: true });
    expect(resolved.effective).toEqual({ kind: "off" });
    expect(resolved.mappingKind).toBe("downgraded");
    expect(resolved.fallbackReason).toMatch(/best-effort policy disabled reasoning/);
  });

  it("maps token-budget thinking through a reviewed policy and fails closed without one", () => {
    const deep = resolveReasoning(req({ intent: "DEEP", explicit: true }), budget, { budgetPolicy });
    expect(deep.effective).toEqual({ kind: "budget", budgetTokens: 8192 });
    expect(deep.mappingKind).toBe("normalized");
    expect(deep.fallbackReason).toMatch(/reviewed budget policy to 8192/);
    for (const intent of ["ECONOMY", "BALANCED", "MAXIMUM"] as const) {
      const mapped = resolveReasoning(req({ intent, explicit: true }), budget, { budgetPolicy });
      expect(mapped.effective).toEqual({ kind: "budget", budgetTokens: budgetPolicy[intent.toLowerCase() as keyof typeof budgetPolicy] });
    }
    try {
      resolveReasoning(req({ intent: "DEEP", explicit: true }), budget);
      expect.unreachable("expected no-budget-policy");
    } catch (error) {
      expect(error).toBeInstanceOf(ReasoningTranslationError);
      expect((error as ReasoningTranslationError).code).toBe("no-budget-policy");
    }
  });

  it("produces secret-free, frozen mapping metadata for diagnostics", () => {
    const resolved = resolveReasoning(req({ intent: "OFF", explicit: true }), binary);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.effective)).toBe(true);
    expect(Object.keys(resolved).sort()).toEqual(["canonicalIntent", "effective", "mappingKind", "requested"]);
    // No reasoning text, prompts, responses, credentials, or account identity.
    const walk = (value: unknown, path: string): string[] => {
      if (value === null || typeof value !== "object") return [];
      const findings: string[] = [];
      for (const [key, child] of Object.entries(value)) {
        if (["prompt", "response", "token", "secret", "password", "email", "identity"].includes(key)) findings.push(`${path}.${key}`);
        findings.push(...walk(child, `${path}.${key}`));
      }
      return findings;
    };
    expect(walk(resolved, "resolved")).toEqual([]);
  });
});
