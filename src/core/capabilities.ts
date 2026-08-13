export type TokenCountingQuality = "upstream" | "exact-local" | "conservative-estimate" | "unsupported";

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

