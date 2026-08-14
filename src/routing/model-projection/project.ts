/**
 * Deterministic model projection engine (#72).
 *
 * Pure, secret-free, no account/credential access:
 * - `projectModelUniverse` projects the trusted registry through a session's
 *   pinned provider->pool bindings into Claude-compatible entries.
 * - `resolveProjection` is the explicit reverse mapping (projection id ->
 *   exact access-provider/model target + pool). Routing never parses ids.
 * - `compileModelUniverseSnapshot` pins a session's model universe from the
 *   control-plane policy at launch-session issue time.
 */

import { createHash } from "node:crypto";
import type { PolicyRevision, ProfileRecord } from "../../control-plane/types.js";
import {
  findModelEvidence,
  modelsForProvider,
  type ModelEvidence,
  type RegistryDocument,
} from "../../registry/model-registry.js";
import {
  isProjectionId,
  RLY_MODEL_PREFIX,
  type ModelProjection,
  type ModelProjectionTrace,
  type ModelUniverseSnapshot,
  type ProviderPoolBinding,
} from "./types.js";

/**
 * Presentation-only provider labels. Never used for routing; two providers
 * exposing the same upstream model get distinct display labels because
 * auth/pool/endpoint/terms are different execution paths.
 */
const PROVIDER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  codex: "Codex",
  cline: "ClinePass",
  gemini: "Gemini",
  antigravity: "Antigravity",
  claude: "Claude",
  "opencode-go": "OpenCode Go",
  alibaba: "Alibaba",
});

/**
 * Presentation-only model labels for the reviewed registry entries. Pure
 * cosmetic: an unknown model falls back to `humanizeModelId`. Never used for
 * routing; the reverse mapping owns routing.
 */
const MODEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.4": "GPT-5.4",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-fable": "Claude Fable",
  "nvidia/nemotron-3.5-lightning:free": "NVIDIA Nemotron 3.5 Lightning (Free)",
  "nvidia/nemotron-nano-12b-v2-vl:free": "NVIDIA Nemotron Nano 12B V2 VL (Free)",
  "openai/gpt-oss-20b:free": "OpenAI GPT-OSS 20B (Free)",
});

const ACRONYMS = new Set(["gpt", "api", "ai", "cli", "ui", "json", "oss", "vl", "id"]);

/** Deterministic, presentation-only fallback humanizer for unknown model ids. */
export function humanizeModelId(upstreamModelId: string): string {
  const tokens = upstreamModelId.split(/[-_/:]+/).filter((token) => token.length > 0);
  return tokens.map((token) => {
    if (/^\d/.test(token)) return token;
    const lower = token.toLowerCase();
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    return token.charAt(0).toUpperCase() + token.slice(1);
  }).join(" ");
}

/** Deterministic presentation label for a provider name. Never a routing key. */
export function providerDisplayName(providerName: string): string {
  return PROVIDER_LABELS[providerName] ?? humanizeModelId(providerName);
}

/** Deterministic presentation label for one exact upstream model id. */
export function modelDisplayName(upstreamModelId: string): string {
  return MODEL_LABELS[upstreamModelId] ?? humanizeModelId(upstreamModelId);
}

/**
 * Stable projection id: `claude-rly-<provider-slug>-<stable-key>`. The slug
 * keeps the provider family visible to the user; the stable key is a short
 * hash of `(providerName, upstreamModelId)` so the same upstream model through
 * two access providers always gets two distinct ids. Ids are handles only —
 * `resolveProjection` owns the reverse mapping.
 */
export function projectionIdFor(providerName: string, upstreamModelId: string): string {
  const slug = providerSlug(providerName);
  const stableKey = createHash("sha256")
    .update(`${providerName}\u0000${upstreamModelId}`)
    .digest("hex")
    .slice(0, 12);
  return `${RLY_MODEL_PREFIX}${slug}-${stableKey}`;
}

function providerSlug(providerName: string): string {
  const slug = providerName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "provider" : slug;
}

/** One projected entry for an exact binding + trusted evidence. */
export function projectionFor(
  binding: ProviderPoolBinding,
  evidence: ModelEvidence,
): ModelProjection {
  return Object.freeze({
    id: projectionIdFor(binding.providerName, evidence.identity.upstreamModelId),
    displayName: `${modelDisplayName(evidence.identity.upstreamModelId)} (${providerDisplayName(binding.providerName)})`,
    providerId: binding.providerId,
    providerName: binding.providerName,
    poolId: binding.poolId,
    upstreamModelId: evidence.identity.upstreamModelId,
    ...(evidence.identity.modelFamily === undefined ? {} : { modelFamily: evidence.identity.modelFamily }),
    compatibilityState: evidence.compatibility.state,
    verifiedAt: evidence.verifiedAt,
  });
}

/**
 * Projects the trusted registry through a session's pinned bindings.
 * Deterministic: sorted by provider name, then registry document order per
 * provider. `BROKEN` compatibility is never projected; `EXPERIMENTAL` is
 * projected only when the session's explicit policy opt-in is enabled.
 */
export function projectModelUniverse(
  registry: RegistryDocument,
  snapshot: ModelUniverseSnapshot,
): readonly ModelProjection[] {
  const projections: ModelProjection[] = [];
  const bindings = [...snapshot.bindings].sort((left, right) => left.providerName.localeCompare(right.providerName));
  for (const binding of bindings) {
    for (const evidence of modelsForProvider(registry, binding.providerName)) {
      if (evidence.compatibility.state === "BROKEN") continue;
      if (evidence.compatibility.state === "EXPERIMENTAL" && !snapshot.experimentalModels) continue;
      projections.push(projectionFor(binding, evidence));
    }
  }
  return Object.freeze(projections);
}

/**
 * Explicit reverse mapping: projection id -> one exact trusted evidence target
 * plus its pinned pool binding. Re-derived per request from the session's
 * pinned snapshot and the CURRENT registry, so a model removed or marked
 * BROKEN/EXPERIMENTAL-ineligible in a newer registry revision fails closed
 * (returns undefined) instead of substituting another model. Routing never
 * parses the id string.
 */
export function resolveProjection(
  projectionId: string,
  snapshot: ModelUniverseSnapshot,
  registry: RegistryDocument,
): Readonly<{ projection: ModelProjection; binding: ProviderPoolBinding; evidence: ModelEvidence }> | undefined {
  if (!isProjectionId(projectionId)) return undefined;
  for (const projection of projectModelUniverse(registry, snapshot)) {
    if (projection.id !== projectionId) continue;
    const binding = snapshot.bindings.find(
      (candidate) => candidate.providerName === projection.providerName && candidate.poolId === projection.poolId,
    );
    if (binding === undefined) return undefined;
    const evidence = findModelEvidence(registry, projection.providerName, projection.upstreamModelId);
    if (evidence === undefined) return undefined;
    return Object.freeze({ projection, binding, evidence });
  }
  return undefined;
}

/** Secret-free allowlisted routing metadata for the route trace. */
export function createModelProjectionTrace(
  projection: ModelProjection,
  snapshot: ModelUniverseSnapshot,
): ModelProjectionTrace {
  return Object.freeze({
    projectionId: projection.id,
    displayName: projection.displayName,
    providerId: projection.providerId,
    upstreamModelId: projection.upstreamModelId,
    poolId: projection.poolId,
    policyRevision: snapshot.policyRevision,
    registryRevision: snapshot.registryRevision,
  });
}

/**
 * Compiles a session's model-universe snapshot from the control-plane policy
 * (issue #72 scope 5). Bindings, deterministically:
 * 1. the profile's own explicit pool -> provider binding (when its provider is
 *    enabled and the pool has at least one `ready` account);
 * 2. every other enabled provider with exactly one eligible pool (>=1 `ready`
 *    account) — the #66 "one default pool per configured provider" convention.
 * A provider with multiple pools and no explicit profile binding is excluded:
 * RLY never chooses an arbitrary pool at discovery or request time.
 */
export function compileModelUniverseSnapshot(
  policy: PolicyRevision,
  registry: RegistryDocument,
  input: Readonly<{ profile?: ProfileRecord; experimentalModels?: boolean }> = {},
): ModelUniverseSnapshot {
  const pools = policy.snapshot.pools;
  const providers = policy.snapshot.providers;
  const readyAccountIds = new Set(
    policy.snapshot.accounts.filter((account) => account.state === "ready").map((account) => account.id),
  );
  const poolIsEligible = (poolId: string): boolean => {
    const pool = pools.find((item) => item.id === poolId);
    if (pool === undefined) return false;
    return pool.memberships.some((membership) => readyAccountIds.has(membership.accountId));
  };
  const bindings = new Map<string, ProviderPoolBinding>();
  const addBinding = (poolId: string, provider: PolicyRevision["snapshot"]["providers"][number]): void => {
    bindings.set(provider.id, {
      providerId: provider.id,
      providerName: provider.name,
      poolId,
    });
  };
  // 1. Explicit profile binding.
  const profilePoolId = input.profile?.poolId;
  if (profilePoolId !== undefined) {
    const pool = pools.find((item) => item.id === profilePoolId);
    const provider = pool === undefined ? undefined : providers.find((item) => item.id === pool.providerId);
    if (pool !== undefined && provider !== undefined && provider.enabled && poolIsEligible(pool.id)) {
      addBinding(pool.id, provider);
    }
  }
  // 2. Other enabled providers with exactly one eligible default pool.
  for (const provider of providers) {
    if (bindings.has(provider.id) || !provider.enabled) continue;
    const eligiblePools = pools.filter((pool) => pool.providerId === provider.id && poolIsEligible(pool.id));
    const defaultPool = eligiblePools.length === 1 ? eligiblePools[0] : undefined;
    if (defaultPool !== undefined) addBinding(defaultPool.id, provider);
  }
  return Object.freeze({
    policyRevision: policy.revision,
    policyHash: policy.hash,
    registryRevision: registry.registryRevision,
    bindings: Object.freeze(
      [...bindings.values()].sort((left, right) => left.providerName.localeCompare(right.providerName)),
    ),
    experimentalModels: input.experimentalModels ?? false,
  });
}
