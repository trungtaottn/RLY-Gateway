import type { ReasoningCapabilityEvidence } from "../core/capabilities.js";
import type {
  NativeReasoningControl,
  ReasoningBudgetPolicy,
  ReasoningIntent,
  ReasoningMappingKind,
  ReasoningRequest,
  ResolvedReasoning,
} from "../core/reasoning.js";

/**
 * Provider-owned reasoning translation boundary (#70).
 *
 * One deterministic translation from canonical reasoning intent + exact model
 * capability evidence (`ReasoningCapabilityEvidence` from the trusted
 * registry) to a provider-native control. No provider names, no LLM
 * classification, no numeric-equivalence claims. Every non-exact mapping
 * records the requested intent, canonical intent, effective native control,
 * mapping kind, and a fallback reason; explicit deep/maximum intents fail
 * closed when the selected model has no safe equivalent (unless an explicit
 * best-effort policy was enabled).
 */

/** Level used when a source mode/intent must become an "enabled" control. */
const NEUTRAL_INTENT: Extract<ReasoningIntent, "ECONOMY" | "BALANCED" | "DEEP" | "MAXIMUM"> = "BALANCED";

const INTENT_RANK: Readonly<Record<ReasoningIntent, number>> = Object.freeze({
  OFF: 0,
  ECONOMY: 1,
  BALANCED: 2,
  DEEP: 3,
  MAXIMUM: 4,
  AUTO: 0,
});

export class ReasoningTranslationError extends Error {
  constructor(
    public readonly code: "unsupported-reasoning" | "no-budget-policy",
    message: string,
  ) {
    super(message);
    this.name = "ReasoningTranslationError";
  }
}

export type ResolveReasoningOptions = Readonly<{
  /** Reviewed per-model budget policy for token-budget controls (never universal). */
  budgetPolicy?: ReasoningBudgetPolicy;
  /** Explicit best-effort opt-in: allow a downgrade when no safe equivalent exists. */
  bestEffort?: boolean;
}>;

/** Levels that disable reasoning are not usable for a positive intent. */
function nativeLevels(levels: readonly string[]): string[] {
  return levels.filter((level) => level !== "none" && level !== "off");
}

/** Deterministic nearest native level for a semantic intent within a model's own levels. */
function nearestLevel(intent: ReasoningIntent, levels: readonly string[]): string {
  const usable = nativeLevels(levels);
  if (usable.length === 0) {
    throw new ReasoningTranslationError(
      "unsupported-reasoning",
      `discrete-effort control declares only non-reasoning levels; cannot translate ${intent} intent`,
    );
  }
  switch (intent) {
    case "ECONOMY":
      return usable[0] as string;
    case "BALANCED":
      return usable[Math.floor((usable.length - 1) / 2)] as string;
    case "DEEP":
      // One tier below the deepest when a distinct deep tier exists; otherwise
      // the deepest tier itself (lossy mapping is still recorded, never silent).
      return usable[usable.length >= 3 ? usable.length - 2 : usable.length - 1] as string;
    case "MAXIMUM":
      return usable[usable.length - 1] as string;
    default:
      return usable[Math.floor((usable.length - 1) / 2)] as string;
  }
}

function budgetTokensFor(intent: ReasoningIntent, policy: ReasoningBudgetPolicy): number {
  switch (intent) {
    case "ECONOMY": return policy.economy;
    case "BALANCED": return policy.balanced;
    case "DEEP": return policy.deep;
    case "MAXIMUM": return policy.maximum;
    default: return policy.balanced;
  }
}

/** Enables reasoning with the nearest control a non-adaptive capability exposes. */
function enabledControl(
  capability: ReasoningCapabilityEvidence,
  options: ResolveReasoningOptions,
): NativeReasoningControl {
  switch (capability.controlKind) {
    case "discrete-effort":
      return { kind: "effort", level: nearestLevel(NEUTRAL_INTENT, capability.effortLevels ?? []) };
    case "binary":
      return { kind: "binary", enabled: true };
    case "token-budget":
      if (options.budgetPolicy === undefined) {
        throw new ReasoningTranslationError(
          "no-budget-policy",
          "token-budget reasoning requires a reviewed per-model budget policy; cannot enable reasoning",
        );
      }
      return { kind: "budget", budgetTokens: budgetTokensFor(NEUTRAL_INTENT, options.budgetPolicy) };
    case "adaptive":
      return { kind: "adaptive", enabled: true };
    case "none":
      throw new ReasoningTranslationError(
        "unsupported-reasoning",
        "selected model does not support reasoning; cannot enable reasoning",
      );
  }
}

function resolved(input: {
  requested: ReasoningRequest;
  canonicalIntent: ReasoningIntent;
  effective: NativeReasoningControl;
  mappingKind: ReasoningMappingKind;
  fallbackReason?: string;
}): ResolvedReasoning {
  return Object.freeze({
    requested: Object.freeze({ ...input.requested }),
    canonicalIntent: input.canonicalIntent,
    effective: Object.freeze({ ...input.effective }),
    mappingKind: input.mappingKind,
    ...(input.fallbackReason === undefined ? {} : { fallbackReason: input.fallbackReason }),
  });
}

/**
 * Deterministically translates a canonical reasoning request into the nearest
 * provider-native control for the selected model's capability evidence.
 *
 * Precedence:
 * 1. Explicit OFF is always satisfiable (reasoning off).
 * 2. Adaptive source mode is honored when the control is adaptive, else mapped
 *    to the nearest enabled control with a recorded fallback reason.
 * 3. AUTO (provider/model default) delegates to the provider.
 * 4. Unsupported reasoning fails closed unless an explicit best-effort policy
 *    enabled the downgrade (recorded, never silent).
 * 5. Exact same-family source effort is preserved when the model supports the
 *    exact level.
 * 6. Otherwise the semantic intent maps deterministically per control kind.
 */
export function resolveReasoning(
  request: ReasoningRequest,
  capability: ReasoningCapabilityEvidence,
  options: ResolveReasoningOptions = {},
): ResolvedReasoning {
  const intent = request.intent;

  if (intent === "OFF") {
    return resolved({ requested: request, canonicalIntent: "OFF", effective: { kind: "off" }, mappingKind: "exact" });
  }

  // Adaptive source mode is its own fidelity signal: honor adaptive controls,
  // otherwise realize it as the nearest enabled control with a recorded reason.
  if (request.sourceMode === "adaptive") {
    if (capability.adaptive) {
      return resolved({
        requested: request,
        canonicalIntent: intent,
        effective: { kind: "adaptive", enabled: true },
        mappingKind: "exact",
      });
    }
    return resolved({
      requested: request,
      canonicalIntent: intent,
      effective: enabledControl(capability, options),
      mappingKind: "normalized",
      fallbackReason: "adaptive source mode has no adaptive control; mapped to the nearest enabled control",
    });
  }

  if (intent === "AUTO") {
    return resolved({
      requested: request,
      canonicalIntent: "AUTO",
      effective: { kind: "provider-default" },
      mappingKind: "default",
    });
  }

  const unsupported = !capability.supported || capability.controlKind === "none";
  if (unsupported) {
    if (options.bestEffort === true) {
      return resolved({
        requested: request,
        canonicalIntent: intent,
        effective: { kind: "off" },
        mappingKind: "downgraded",
        fallbackReason: "selected model does not support reasoning; best-effort policy disabled reasoning",
      });
    }
    throw new ReasoningTranslationError(
      "unsupported-reasoning",
      `selected model does not support reasoning; cannot translate ${intent} intent`,
    );
  }

  // Exact same-family source effort preservation (e.g. `xhigh` → xhigh).
  if (
    request.sourceEffort !== undefined
    && capability.controlKind === "discrete-effort"
    && (capability.effortLevels ?? []).includes(request.sourceEffort)
  ) {
    return resolved({
      requested: request,
      canonicalIntent: intent,
      effective: { kind: "effort", level: request.sourceEffort },
      mappingKind: "exact",
    });
  }

  switch (capability.controlKind) {
    case "discrete-effort": {
      const level = nearestLevel(intent, capability.effortLevels ?? []);
      const fallbackReason = request.sourceEffort !== undefined && level !== request.sourceEffort
        ? `source effort ${request.sourceEffort} is not natively supported; intent ${intent} mapped to nearest level ${level}`
        : `intent ${intent} mapped to native level ${level}`;
      return resolved({
        requested: request,
        canonicalIntent: intent,
        effective: { kind: "effort", level },
        mappingKind: "normalized",
        fallbackReason,
      });
    }
    case "binary": {
      const downgraded = INTENT_RANK[intent] >= INTENT_RANK.DEEP;
      return resolved({
        requested: request,
        canonicalIntent: intent,
        effective: { kind: "binary", enabled: true },
        mappingKind: downgraded ? "downgraded" : "normalized",
        fallbackReason: `binary reasoning control has no effort granularity; ${intent} mapped to enabled`,
      });
    }
    case "adaptive":
      return resolved({
        requested: request,
        canonicalIntent: intent,
        effective: { kind: "adaptive", enabled: true },
        mappingKind: "normalized",
        fallbackReason: `adaptive reasoning control has no effort granularity; ${intent} mapped to adaptive enabled`,
      });
    case "token-budget": {
      if (options.budgetPolicy === undefined) {
        throw new ReasoningTranslationError(
          "no-budget-policy",
          `token-budget reasoning requires a reviewed per-model budget policy; cannot translate ${intent} intent`,
        );
      }
      const budgetTokens = budgetTokensFor(intent, options.budgetPolicy);
      return resolved({
        requested: request,
        canonicalIntent: intent,
        effective: { kind: "budget", budgetTokens },
        mappingKind: "normalized",
        fallbackReason: `token-budget control; intent ${intent} mapped through the reviewed budget policy to ${String(budgetTokens)}`,
      });
    }
  }
}
