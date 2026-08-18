import type { LogicalTier, TierMappingPolicy } from "./types.js";

export const DEFAULT_TIER_MAPPING_REVISION = 1;

/**
 * Deterministic mapping key: `accessProviderId|modelFamily|tier`. Families may
 * contain `/` (e.g. `openai/codex`) but never the `|` separator.
 */
export function tierMappingKey(accessProviderId: string, modelFamily: string, tier: LogicalTier): string {
  return `${accessProviderId}|${modelFamily}|${tier}`;
}

/**
 * Built-in reviewed tier mapping (frozen, revisioned). Mirrors the trusted
 * registry pattern: entries are reviewed evidence, never derived at runtime.
 * Keys map `(provider, family, tier)` to the exact upstream model id that is
 * the configured/verified tier target for that access path. A tier target is
 * still validated through #68 exact-pin eligibility at resolution time.
 *
 * The ClinePass aggregator rows pin the owner-approved fixtures: `fable` stays
 * inside the parent model's family on a multi-family access provider and never
 * jumps to another family's strong model.
 */
const ENTRIES: Readonly<Record<string, string>> = Object.freeze({
  // ClinePass + OpenAI/Codex family: Terra-class parent → Sol-class fable target.
  "cline|openai/codex|fable": "gpt-5.6-sol",
  // ClinePass + DeepSeek family: Flash-class parent → Pro-class fable target.
  "cline|deepseek|fable": "deepseek-v4-pro",
  // ClinePass + Anthropic family: reviewed Anthropic-family tier targets.
  "cline|anthropic|fable": "claude-fable",
  "cline|anthropic|opus": "claude-opus-4-8",
  "cline|anthropic|sonnet": "claude-sonnet-4-5",
});

export const defaultTierMapping: TierMappingPolicy = Object.freeze({
  revision: DEFAULT_TIER_MAPPING_REVISION,
  entries: ENTRIES,
});
