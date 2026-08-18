export type TokenCountingQuality = "upstream" | "exact-local" | "conservative-estimate" | "unsupported";

/**
 * How a provider/model exposes user-controlled reasoning, sufficient for #70 to
 * translate reasoning intent without scraping provider names. This is reviewed
 * evidence, not reputation scoring.
 */
export type ReasoningControlKind = "discrete-effort" | "adaptive" | "binary" | "token-budget" | "none";

export type ReasoningCapabilityEvidence = Readonly<{
  /** Whether this exact access path supports reasoning at all (mirrors `capabilities.reasoning`). */
  supported: boolean;
  /** The control shape the provider/model exposes for reasoning. */
  controlKind: ReasoningControlKind;
  /** Discrete effort levels when `controlKind` is `discrete-effort` (e.g. low/medium/high/xhigh/max). */
  effortLevels?: readonly string[] | undefined;
  /** Adaptive/auto thinking is supported. */
  adaptive: boolean;
  /** Token-budget style reasoning control is supported. */
  tokenBudget: boolean;
  /** Reasoning can be interleaved with tool use. */
  reasoningWithTools: boolean;
}>;

export type ProviderCapabilities = Readonly<{
  streaming: boolean;
  tools: boolean;
  parallelTools: boolean;
  images: boolean;
  reasoning: boolean;
  redactedReasoning: boolean;
  structuredOutput: boolean;
  tokenCounting: TokenCountingQuality;
}>;

export type CapabilityRequirement = Exclude<keyof ProviderCapabilities, "tokenCounting">;

export function missingCapabilities(
  capabilities: ProviderCapabilities,
  required: readonly CapabilityRequirement[],
): CapabilityRequirement[] {
  return required.filter((capability) => !capabilities[capability]);
}

