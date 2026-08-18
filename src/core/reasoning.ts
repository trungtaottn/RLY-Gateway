/**
 * Provider-neutral reasoning/thinking intent contract (#70).
 *
 * Core routing carries ONLY this canonical intent plus source fidelity;
 * translating it into a provider-native parameter is owned by the provider
 * adapter boundary (`src/providers/reasoning.ts`). These semantic intents
 * never claim numeric equivalence across providers: a provider/model may
 * expose fewer (or more) effort levels, adaptive thinking, a token budget, or
 * binary on/off, and the translation boundary records exactly how each intent
 * was realized (exact / normalized / downgraded / default). `high`, `xhigh`,
 * `adaptive`, binary `reasoning=true`, and token-budget thinking are distinct
 * kinds and are never collapsed into one another silently.
 */

export type ReasoningIntent = "OFF" | "ECONOMY" | "BALANCED" | "DEEP" | "MAXIMUM" | "AUTO";

export type ReasoningSourceMode = "disabled" | "enabled" | "adaptive";

export type ReasoningRequest = Readonly<{
  /** Provider-neutral semantic intent. */
  intent: ReasoningIntent;
  /** Source fidelity: the client's own mode when one was sent. */
  sourceMode?: ReasoningSourceMode;
  /** Source fidelity: the client's own effort label when one was sent. */
  sourceEffort?: string;
  /** Whether the source explicitly requested reasoning (vs provider default). */
  explicit: boolean;
}>;

/** Deterministic effort-label → semantic intent mapping for common names. */
const EFFORT_INTENTS: Readonly<Record<string, ReasoningIntent>> = Object.freeze({
  low: "ECONOMY",
  medium: "BALANCED",
  high: "DEEP",
  xhigh: "MAXIMUM",
  max: "MAXIMUM",
});

export function intentForEffort(effort: string): ReasoningIntent | undefined {
  return EFFORT_INTENTS[effort];
}

/** Decoded client-side reasoning signal (wire fields only, no assumptions). */
export type ReasoningWireSignal = Readonly<{
  thinking?: ReasoningSourceMode;
  effort?: string;
}>;

/**
 * Builds the canonical reasoning request from a decoded client signal.
 * Explicit effort (when present) is the most specific signal and wins over the
 * thinking mode; otherwise `thinking.type` derives the intent. No signal at
 * all maps to `AUTO` with `explicit: false` (provider/model default).
 */
export function reasoningRequestFromWire(signal: ReasoningWireSignal): ReasoningRequest {
  if (signal.effort !== undefined) {
    const effortIntent = intentForEffort(signal.effort);
    if (effortIntent !== undefined) {
      return {
        intent: effortIntent,
        ...(signal.thinking === undefined ? {} : { sourceMode: signal.thinking }),
        sourceEffort: signal.effort,
        explicit: true,
      };
    }
  }
  switch (signal.thinking) {
    case "disabled":
      return { intent: "OFF", sourceMode: "disabled", explicit: true };
    case "adaptive":
      return { intent: "AUTO", sourceMode: "adaptive", explicit: true };
    case "enabled":
      return { intent: "BALANCED", sourceMode: "enabled", explicit: true };
    default:
      return { intent: "AUTO", explicit: false };
  }
}

/**
 * The provider-native control selected by the translation boundary. Adapters
 * own the exact wire parameter naming for each kind; the boundary only picks
 * the semantic native control.
 */
export type NativeReasoningControl =
  | { kind: "off" }
  | { kind: "provider-default" }
  | { kind: "binary"; enabled: boolean }
  | { kind: "effort"; level: string }
  | { kind: "adaptive"; enabled: boolean }
  | { kind: "budget"; budgetTokens: number };

/** How the requested intent was realized for the selected model. */
export type ReasoningMappingKind = "exact" | "normalized" | "downgraded" | "default";

/**
 * Secret-free translation result. Control metadata only — never reasoning
 * text, prompts, responses, credentials, or account identity.
 */
export type ResolvedReasoning = Readonly<{
  requested: ReasoningRequest;
  canonicalIntent: ReasoningIntent;
  effective: NativeReasoningControl;
  mappingKind: ReasoningMappingKind;
  fallbackReason?: string;
}>;

/**
 * Reviewed per-model/provider token-budget policy. #70 never invents a
 * universal hardcoded token number: budget-style providers translate semantic
 * intent through a reviewed policy supplied by the owning model evidence, or
 * fail closed when no such policy exists.
 */
export type ReasoningBudgetPolicy = Readonly<{
  economy: number;
  balanced: number;
  deep: number;
  maximum: number;
}>;
