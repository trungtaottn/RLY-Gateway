import type { CompatibilityState, ModelEvidence } from "../registry/model-registry.js";
import type { CompatibilityPolicy } from "./types.js";

/**
 * Compatibility policy (#124) — freshness/staleness + enforcement inputs, plus
 * the legacy seed/reference mapping policy.
 *
 * Legacy static registry compatibility states (`model.compatibility.state`)
 * become SEED/REFERENCE data: they can influence the seed-level fallback
 * derivation for tooling/tests but can NEVER silently equal a reviewed v2
 * decision. The Effective Compatibility Registry is the sole runtime
 * compatibility authority; the seed mapping below is the documented downgrade
 * used only when no reviewed v2 data exists for a model.
 */

export const LEGACY_SEED_POLICY = "seed-reference-only" as const;

/** Default policy: no fabricated drift signals, no overrides, no bypass. */
export function defaultCompatibilityPolicy(): CompatibilityPolicy {
  return Object.freeze({ legacySeedPolicy: LEGACY_SEED_POLICY });
}

/**
 * Seed-level fallback derivation from a legacy static registry state.
 *
 * - `VERIFIED` rows WITHOUT a `claimRef` are legacy/untrusted for v2 claim
 *   authority (#122): they derive `experimental` (evidence-seeded, never
 *   reviewed trust) so they can never silently satisfy v2 reviewed trust.
 * - `VERIFIED` rows WITH a `claimRef` derive `trusted-seed` — the reference
 *   data points at an exact claim that the ECR still resolves independently.
 * - `EXPERIMENTAL` derives `experimental`.
 * - `BROKEN` derives `broken` (hard negative seed).
 */
export type SeedCompatibilityHint = "trusted-seed" | "experimental" | "broken" | "unknown";

export function seedHintForModel(model: ModelEvidence): SeedCompatibilityHint {
  switch (model.compatibility.state) {
    case "VERIFIED":
      return model.compatibility.claimRef === undefined ? "experimental" : "trusted-seed";
    case "EXPERIMENTAL":
      return "experimental";
    case "BROKEN":
      return "broken";
  }
}

/** True when the row is seed-only (no claim reference to a v2 claim). */
export function isSeedOnlyModel(model: ModelEvidence): boolean {
  return model.compatibility.claimRef === undefined;
}

/**
 * Builds the fresh policy inputs for one runtime: current client baseline,
 * pinned protocol/fixture revisions, adapter/auth surface per provider, and
 * the material RLY build. Missing inputs default to "no drift signal".
 */
export function runtimeCompatibilityPolicy(input: Readonly<{
  supportedClientBaseline?: string;
  pinnedProtocolRevision?: string;
  pinnedFixtureRevision?: string;
  rlyBuildVersion?: string;
  maxEvidenceAgeMs?: number;
  deprecatedModelFingerprints?: readonly string[];
  providerAccessConfig?: CompatibilityPolicy["providerAccessConfig"];
}>): CompatibilityPolicy {
  return Object.freeze({
    legacySeedPolicy: LEGACY_SEED_POLICY,
    ...(input.supportedClientBaseline === undefined ? {} : { supportedClientBaseline: input.supportedClientBaseline }),
    ...(input.pinnedProtocolRevision === undefined ? {} : { pinnedProtocolRevision: input.pinnedProtocolRevision }),
    ...(input.pinnedFixtureRevision === undefined ? {} : { pinnedFixtureRevision: input.pinnedFixtureRevision }),
    ...(input.rlyBuildVersion === undefined ? {} : { rlyBuildVersion: input.rlyBuildVersion }),
    ...(input.maxEvidenceAgeMs === undefined ? {} : { maxEvidenceAgeMs: input.maxEvidenceAgeMs }),
    ...(input.deprecatedModelFingerprints === undefined ? {} : { deprecatedModelFingerprints: Object.freeze([...input.deprecatedModelFingerprints]) }),
    ...(input.providerAccessConfig === undefined ? {} : { providerAccessConfig: input.providerAccessConfig }),
  });
}

export type { CompatibilityState };
