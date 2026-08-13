import type { ProviderCapabilities } from "../core/capabilities.js";
import type { RouteRecord } from "../core/router.js";
import type { GatewayConfig } from "../config/schema.js";
import { parseCredentialRef } from "../credentials/credential-ref.js";

export type ModelEvidence = Readonly<{
  logicalId: string;
  upstreamId: string;
  verifiedAt: string;
  fixtureVersion: string;
  tokenCounting: ProviderCapabilities["tokenCounting"];
  capabilities: ProviderCapabilities;
}>;

export type RegistryDocument = Readonly<{ registryRevision: number; models: readonly ModelEvidence[] }>;

const nvidiaNemotronCapabilities: ProviderCapabilities = Object.freeze({
  streaming: true,
  tools: true,
  parallelTools: false,
  images: false,
  reasoning: true,
  redactedReasoning: false,
  structuredOutput: false,
  tokenCounting: "conservative-estimate",
});

const deepSeekFlashCapabilities: ProviderCapabilities = Object.freeze({
  streaming: true,
  tools: false,
  parallelTools: false,
  images: false,
  reasoning: true,
  redactedReasoning: false,
  structuredOutput: false,
  tokenCounting: "conservative-estimate",
});

const nvidiaNemotronNanoCapabilities: ProviderCapabilities = Object.freeze({
  streaming: true,
  tools: true,
  parallelTools: false,
  images: true,
  reasoning: true,
  redactedReasoning: false,
  structuredOutput: false,
  tokenCounting: "conservative-estimate",
});

const openAiGptOssCapabilities: ProviderCapabilities = Object.freeze({
  streaming: true,
  tools: true,
  parallelTools: false,
  images: false,
  reasoning: true,
  redactedReasoning: false,
  structuredOutput: true,
  tokenCounting: "conservative-estimate",
});

/** Reviewed evidence only. Provider probes report drift but never mutate this document. */
export const directProviderRegistry: RegistryDocument = Object.freeze({
  registryRevision: 1,
  models: Object.freeze([
    Object.freeze({ logicalId: "openrouter/nvidia/nemotron-3.5-lightning:free", upstreamId: "nvidia/nemotron-3.5-lightning:free", verifiedAt: "2026-08-13", fixtureVersion: "openai-chat-v1", tokenCounting: "conservative-estimate", capabilities: nvidiaNemotronCapabilities }),
    Object.freeze({ logicalId: "openrouter/nvidia/nemotron-nano-12b-v2-vl:free", upstreamId: "nvidia/nemotron-nano-12b-v2-vl:free", verifiedAt: "2026-08-13", fixtureVersion: "openai-chat-v1", tokenCounting: "conservative-estimate", capabilities: nvidiaNemotronNanoCapabilities }),
    Object.freeze({ logicalId: "openrouter/openai/gpt-oss-20b:free", upstreamId: "openai/gpt-oss-20b:free", verifiedAt: "2026-08-13", fixtureVersion: "openai-chat-v1", tokenCounting: "conservative-estimate", capabilities: openAiGptOssCapabilities }),
    Object.freeze({ logicalId: "deepseek/deepseek-v4-flash", upstreamId: "deepseek-v4-flash", verifiedAt: "2026-08-13", fixtureVersion: "openai-chat-v1", tokenCounting: "conservative-estimate", capabilities: deepSeekFlashCapabilities }),
  ]),
});

/** Keeps probe observations separate from declarative evidence; callers must explicitly persist reviewed changes. */
export function findModelEvidence(registry: RegistryDocument, providerId: string, modelId: string): ModelEvidence | undefined {
  return registry.models.find((model) => model.logicalId === `${providerId}/${modelId}` || model.upstreamId === modelId);
}

/** Config selects an evidence-backed route; unknown models have no route. */
export function routesFromConfig(config: GatewayConfig, registry: RegistryDocument = directProviderRegistry): ReadonlyMap<string, RouteRecord> {
  const records: [string, RouteRecord][] = [];
  for (const [role, route] of Object.entries(config.routes)) {
    if (route === undefined) continue;
    const evidence = findModelEvidence(registry, route.provider, route.model);
    if (!evidence) continue;
    records.push([role, Object.freeze({
      role,
      providerId: route.provider,
      modelId: route.model,
      adapterId: `${route.provider}-direct`,
      credentialRef: Object.freeze(parseCredentialRef(route.credential)),
      capabilities: Object.freeze({ ...evidence.capabilities }),
    })]);
  }
  return new Map(records);
}

export function resolveConfiguredRoute(routes: ReadonlyMap<string, RouteRecord>, requestedModel: string): RouteRecord | undefined {
  const explicit = routes.get(requestedModel) ?? [...routes.values()].find((route) => route.modelId === requestedModel);
  if (explicit) return explicit;
  const helperRole = new Map<string, "fast" | "primary">([
    ["claude-haiku-4-5", "fast"],
    ["claude-sonnet-5", "primary"],
    ["claude-opus-4-8", "primary"],
  ]).get(requestedModel.toLowerCase());
  if (helperRole) return routes.get(helperRole);
  return undefined;
}
