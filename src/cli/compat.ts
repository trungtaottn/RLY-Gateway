import { ClaimEvidenceStore } from "../canary/artifact.js";
import { CLAUDE_CODE_CONTRACT } from "../canary/client-fixtures.js";
import { EffectiveCompatibilityRegistry } from "../compatibility/registry.js";
import { REQUIRED_RLY_FEATURES } from "../compatibility/features.js";
import { runtimeCompatibilityPolicy } from "../compatibility/policy.js";
import { ReviewDecisionStore, QuarantineStore, REVIEW_SOURCE, QUARANTINE_SOURCE } from "../compatibility/stores.js";
import { RUNTIME_VERSION } from "../runtime/gateway-attestation.js";
import { findModelEvidence, directProviderRegistry } from "../registry/model-registry.js";
import type { GatewayConfig } from "../config/schema.js";
import { loadConfig } from "../config/load-config.js";
import { defaultControlPlaneDirectory } from "../storage/paths.js";
import type { ClaimFeature } from "../canary/claim.js";
import { CLAIM_FEATURES } from "../canary/claim.js";

/**
 * `rly compat` — Effective Compatibility Registry operator surface (#124).
 *
 * - `status` — secret-free counts + policy for review decisions and quarantines.
 * - `review promote|reject <claimKey> <feature>` — an EXPLICIT reviewed trust
 *   decision tied to the claim's exact evidence revision. A PASS observation
 *   never auto-promotes; the decision covers only the current evidence snapshot
 *   (any new observation requires re-review).
 * - `quarantine <claimKey> <feature> --reason <typed>` — a strong reproducible
 *   failure quarantines the EXACT claim/path/feature (narrow scope; never
 *   deletes historical evidence). Required features fail closed.
 * - `lift <claimKey> <feature>` — explicit quarantine lift (audit-friendly).
 * - `explain <provider> <model>` — why a target is trusted/stale/quarantined/
 *   experimental/blocked (claim identity, trust decision, evidence layers,
 *   health, freshness, quarantine reason, enforcement reason) — secret-free.
 *
 * Decision/quarantine records carry reviewer/source/reason/timestamp/revision
 * metadata ONLY — never credentials, account identity, prompts, responses, or
 * reasoning text.
 */

export type CompatAction =
  | Readonly<{ kind: "status" }>
  | Readonly<{ kind: "review"; decision: "promote" | "reject"; claimKey: string; feature: ClaimFeature; reviewer: string; reason: string; source: string }>
  | Readonly<{ kind: "quarantine"; claimKey: string; feature: ClaimFeature; reason: string; source: string }>
  | Readonly<{ kind: "lift"; claimKey: string; feature: ClaimFeature; by: string; reason: string }>
  | Readonly<{ kind: "explain"; provider: string; model: string; feature?: ClaimFeature }>;

function requireClaimFeature(feature: string): ClaimFeature {
  if (!(CLAIM_FEATURES as readonly string[]).includes(feature)) {
    throw new Error(`Unknown claim feature ${feature}; expected one of: ${CLAIM_FEATURES.join(", ")}`);
  }
  return feature as ClaimFeature;
}

function optionalFlagValue(options: readonly string[], flag: string, missing: string): string | undefined {
  const index = options.indexOf(flag);
  if (index < 0) return undefined;
  const value = options[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(missing);
  if (options.filter((item) => item === flag).length !== 1) throw new Error(`${flag} may be provided once`);
  return value;
}

export function parseCompatArgs(args: readonly string[]): CompatAction {
  const rest = args.slice(1).filter((value, index, all) => value !== "--config" && all[index - 1] !== "--config");
  const kind = rest[0];
  if (kind === undefined) throw new Error("compat requires status, review, quarantine, lift, or explain");
  if (kind === "status") {
    if (rest.length > 1) throw new Error("compat status accepts no arguments");
    return { kind: "status" };
  }
  if (kind === "review") {
    const decision = rest[1];
    if (decision !== "promote" && decision !== "reject") throw new Error("review requires promote or reject");
    const claimKey = rest[2];
    const feature = rest[3];
    if (claimKey === undefined || feature === undefined) throw new Error("review requires <claimKey> <feature>");
    return {
      kind: "review",
      decision,
      claimKey,
      feature: requireClaimFeature(feature),
      reviewer: optionalFlagValue(rest, "--reviewer", "--reviewer requires a value") ?? "owner",
      reason: optionalFlagValue(rest, "--reason", "--reason requires a value") ?? `reviewed-${decision}`,
      source: optionalFlagValue(rest, "--source", "--source requires a value") ?? REVIEW_SOURCE,
    };
  }
  if (kind === "quarantine") {
    const claimKey = rest[1];
    const feature = rest[2];
    if (claimKey === undefined || feature === undefined) throw new Error("quarantine requires <claimKey> <feature>");
    const reason = optionalFlagValue(rest, "--reason", "--reason is required for quarantine");
    if (reason === undefined) throw new Error("quarantine requires --reason <typed reason>");
    return {
      kind: "quarantine",
      claimKey,
      feature: requireClaimFeature(feature),
      reason,
      source: optionalFlagValue(rest, "--source", "--source requires a value") ?? QUARANTINE_SOURCE,
    };
  }
  if (kind === "lift") {
    const claimKey = rest[1];
    const feature = rest[2];
    if (claimKey === undefined || feature === undefined) throw new Error("lift requires <claimKey> <feature>");
    return {
      kind: "lift",
      claimKey,
      feature: requireClaimFeature(feature),
      by: optionalFlagValue(rest, "--by", "--by requires a value") ?? "owner",
      reason: optionalFlagValue(rest, "--reason", "--reason requires a value") ?? "quarantine-lifted",
    };
  }
  if (kind === "explain") {
    const provider = rest[1];
    const model = rest[2];
    if (provider === undefined || model === undefined) throw new Error("explain requires <accessProviderId> <modelId>");
    const feature = optionalFlagValue(rest, "--feature", "--feature requires a value");
    return {
      kind: "explain",
      provider,
      model,
      ...(feature === undefined ? {} : { feature: requireClaimFeature(feature) }),
    };
  }
  throw new Error("compat requires status, review, quarantine, lift, or explain");
}

async function controlPlaneDirectory(config: GatewayConfig): Promise<string> {
  return config.controlPlane.dataDirectory ?? defaultControlPlaneDirectory();
}

/** Builds the registry facade with the pinned runtime policy (like owned-gateway). */
function registryFor(directory: string): EffectiveCompatibilityRegistry {
  return new EffectiveCompatibilityRegistry({
    claims: new ClaimEvidenceStore(directory),
    reviews: new ReviewDecisionStore(directory),
    quarantines: new QuarantineStore(directory),
    policy: runtimeCompatibilityPolicy({
      supportedClientBaseline: CLAUDE_CODE_CONTRACT.baseline,
      pinnedProtocolRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
      pinnedFixtureRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
      rlyBuildVersion: RUNTIME_VERSION,
    }),
  });
}

export async function runCompatCommand(action: CompatAction, configPath: string): Promise<number> {
  const config = await loadConfig(configPath);
  const directory = await controlPlaneDirectory(config);
  const claimStore = new ClaimEvidenceStore(directory);
  const reviews = new ReviewDecisionStore(directory);
  const quarantines = new QuarantineStore(directory);
  const registry = registryFor(directory);
  if (action.kind === "status") {
    console.log(JSON.stringify(await registry.summary()));
    return 0;
  }
  if (action.kind === "review") {
    const claim = await claimStore.loadClaim(action.claimKey);
    if (claim === undefined) {
      console.log(JSON.stringify({ ok: false, error: "claim-not-found", claimKey: action.claimKey }));
      return 1;
    }
    const { evidenceRevisionFor } = await import("../compatibility/features.js");
    const result = await reviews.addDecision({
      claimKey: action.claimKey,
      feature: action.feature,
      decision: action.decision,
      evidenceRevision: evidenceRevisionFor(claim),
      reviewer: action.reviewer,
      source: action.source,
      reason: action.reason,
      decidedAt: new Date().toISOString(),
      rlyBuildVersion: RUNTIME_VERSION,
    });
    console.log(JSON.stringify({ ok: true, decision: result.decision, path: result.path }));
    return 0;
  }
  if (action.kind === "quarantine") {
    const result = await quarantines.quarantine({
      claimKey: action.claimKey,
      feature: action.feature,
      reason: action.reason,
      source: action.source,
      quarantinedAt: new Date().toISOString(),
      rlyBuildVersion: RUNTIME_VERSION,
    });
    console.log(JSON.stringify({ ok: true, record: result.record, path: result.path }));
    return 0;
  }
  if (action.kind === "lift") {
    try {
      const result = await quarantines.lift(action.claimKey, action.feature, { by: action.by, reason: action.reason });
      console.log(JSON.stringify({ ok: true, record: result.record, path: result.path }));
      return 0;
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "lift-failed" }));
      return 1;
    }
  }
  // explain
  const row = findModelEvidence(directProviderRegistry, action.provider, action.model);
  if (row === undefined) {
    console.log(JSON.stringify({ ok: false, error: "model-not-found", provider: action.provider, model: action.model }));
    return 1;
  }
  const features: readonly ClaimFeature[] = action.feature === undefined ? REQUIRED_RLY_FEATURES : [action.feature];
  const explanation = await registry.explain(row, features);
  console.log(JSON.stringify(explanation));
  return 0;
}
