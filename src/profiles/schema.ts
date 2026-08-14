import { z } from "zod";
import { missingCapabilities, type CapabilityRequirement, type ProviderCapabilities } from "../core/capabilities.js";
import type { ModelRole } from "../core/canonical-request.js";

export const MODEL_ROLE_NAMES = ["primary", "fast", "reasoning"] as const;
export type ProfileModelRole = (typeof MODEL_ROLE_NAMES)[number];

const capabilityFlags = z.object({
  streaming: z.boolean().optional(),
  tools: z.boolean().optional(),
  parallelTools: z.boolean().optional(),
  images: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  redactedReasoning: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  tokenCounting: z.enum(["upstream", "exact-local", "conservative-estimate", "unsupported"]).optional(),
});

export const capabilityPolicySchema = capabilityFlags.strict();
export const launchPolicySchema = z.object({
  executable: z.string().min(1).optional(),
}).strict();

export type CapabilityPolicy = z.infer<typeof capabilityPolicySchema>;
export type LaunchPolicy = z.infer<typeof launchPolicySchema>;

export function parseCapabilityPolicy(value: unknown): CapabilityPolicy {
  if (value === undefined || value === null) return {};
  return capabilityPolicySchema.parse(value);
}

export function parseLaunchPolicy(value: unknown): LaunchPolicy {
  if (value === undefined || value === null) return {};
  return launchPolicySchema.parse(value);
}

export function applyCapabilityPolicy(
  base: ProviderCapabilities,
  policy: CapabilityPolicy,
): ProviderCapabilities {
  return {
    streaming: policy.streaming ?? base.streaming,
    tools: policy.tools ?? base.tools,
    parallelTools: policy.parallelTools ?? base.parallelTools,
    images: policy.images ?? base.images,
    reasoning: policy.reasoning ?? base.reasoning,
    redactedReasoning: policy.redactedReasoning ?? base.redactedReasoning,
    structuredOutput: policy.structuredOutput ?? base.structuredOutput,
    tokenCounting: policy.tokenCounting ?? base.tokenCounting,
  };
}

export function isProfileModelRole(value: string): value is ProfileModelRole {
  return (MODEL_ROLE_NAMES as readonly string[]).includes(value);
}

export function asModelRole(value: string): ModelRole {
  return isProfileModelRole(value) ? value : "unknown";
}

export function missingProfileCapabilities(
  capabilities: ProviderCapabilities,
  required: readonly CapabilityRequirement[],
): readonly CapabilityRequirement[] {
  return missingCapabilities(capabilities, required);
}
