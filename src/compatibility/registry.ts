import { claimIdentityFor, claimKeyFor, type ClaimFeature, type CompatibilityClaimDocument, type CompatibilityClaimIdentity } from "../canary/claim.js";
import { ClaimEvidenceStore } from "../canary/artifact.js";
import type { ClientKind } from "../canary/types.js";
import type { ModelEvidence } from "../registry/model-registry.js";
import { adapterIdForProvider } from "../canary/run.js";
import { resolveEffectiveCompatibility } from "./effective.js";
import { seedHintForModel } from "./policy.js";
import { ReviewDecisionStore, QuarantineStore } from "./stores.js";
import type { CompatibilityPolicy, EffectiveCompatibility } from "./types.js";
import { assertSecretFree } from "../control-plane/secret-free.js";

/**
 * Effective Compatibility Registry — runtime facade (#124).
 *
 * Ties observed evidence (#122/#123 claim store) + reviewed trust (Review
 * Decision Store) + negative quarantine (Quarantine Store) + freshness/staleness
 * policy into ONE effective answer per exact claim/feature, and exposes
 * in-memory snapshots that the runtime routing consumers (selector, tier
 * resolver, projection, resolve-route) treat as the compatibility authority.
 *
 * The model registry KEEPS owning model identity/capability evidence; this
 * facade adds the compatibility authority and never duplicates the model
 * catalog. Legacy static `model.compatibility.state` values are seed/reference
 * data only: they can influence the seed-level fallback for a model with NO
 * claim evidence, but can never silently equal a reviewed v2 decision.
 *
 * Privacy: snapshots/explanations are secret-free (claim identity, decision
 * metadata, evidence layer statuses, health, freshness, quarantine reason,
 * enforcement reason — never credentials, account identity, prompts,
 * responses, or reasoning text).
 */

export type EffectiveModelSnapshot = ReadonlyMap<string, ReadonlyMap<ClaimFeature, EffectiveCompatibility>>;

export type EffectiveCompatibilityRegistryOptions = Readonly<{
  claims: ClaimEvidenceStore;
  reviews: ReviewDecisionStore;
  quarantines: QuarantineStore;
  policy: CompatibilityPolicy;
  /** Client kind for claim-identity derivation from registry rows. */
  client?: ClientKind;
  /** Adapter id for a provider (defaults to the canary adapter mapping). */
  adapterForProvider?: (providerId: string) => string;
  /** Deterministic clock override for tests. */
  clock?: () => string;
}>;

/** Per-context enforcement inputs for one resolution. */
export type EnforcementContext = Readonly<{
  required: boolean;
  experimentalOverride?: boolean;
}>;

/** Secret-free explanation surface for doctor/status (#124). */
export type EffectiveCompatibilityExplanation = Readonly<{
  logicalId: string;
  accessProviderId: string;
  physicalModelId: string;
  claimIdentity: CompatibilityClaimIdentity;
  seedState: string;
  seedOnly: boolean;
  features: Readonly<Record<string, EffectiveCompatibility>>;
}>;

export class EffectiveCompatibilityRegistry {
  private readonly client: ClientKind;
  private readonly adapterForProvider: (providerId: string) => string;
  private readonly clock: () => string;

  public constructor(private readonly options: EffectiveCompatibilityRegistryOptions) {
    this.client = options.client ?? "claude-code";
    this.adapterForProvider = options.adapterForProvider ?? adapterIdForProvider;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  public get policy(): CompatibilityPolicy {
    return this.options.policy;
  }

  /** Exact claim identity for one registry row under the current policy. */
  public claimIdentityFor(row: ModelEvidence): CompatibilityClaimIdentity {
    const policy = this.options.policy;
    if (policy.supportedClientBaseline === undefined || policy.pinnedProtocolRevision === undefined) {
      throw new Error("Compatibility policy must pin supportedClientBaseline and pinnedProtocolRevision to derive claim identities");
    }
    return claimIdentityFor({
      client: this.client,
      clientVersion: policy.supportedClientBaseline,
      contract: { fixtureRevision: policy.pinnedProtocolRevision },
      adapterId: this.adapterForProvider(row.identity.accessProviderId),
      accessProviderId: row.identity.accessProviderId,
      physicalModelId: row.identity.upstreamModelId,
      ...(row.identity.modelFamily === undefined ? {} : { modelFamily: row.identity.modelFamily }),
    });
  }

  /** Effective answer for one exact claim key + feature. */
  public async effectiveForClaimKey(claimKey: string, feature: ClaimFeature, context: EnforcementContext = { required: false }): Promise<EffectiveCompatibility> {
    const [claim, decisions, records] = await Promise.all([
      this.options.claims.loadClaim(claimKey),
      this.options.reviews.decisionsFor(claimKey, feature),
      this.options.quarantines.recordsFor(claimKey, feature),
    ]);
    return this.resolve(claimKey, feature, claim, decisions, records, context);
  }

  /** Effective answers for every feature of one exact claim identity. */
  public async effectiveForIdentity(
    identity: CompatibilityClaimIdentity,
    features: readonly ClaimFeature[],
    context: EnforcementContext = { required: false },
  ): Promise<ReadonlyMap<ClaimFeature, EffectiveCompatibility>> {
    const entries: [ClaimFeature, EffectiveCompatibility][] = [];
    for (const feature of features) {
      const claimKey = claimKeyFor(identity, feature);
      entries.push([feature, await this.effectiveForClaimKey(claimKey, feature, context)]);
    }
    return new Map(entries);
  }

  /**
   * Effective answers for every required feature of one registry model. When a
   * claim document exists the ECR is authoritative; with NO claim evidence the
   * legacy static state is seed/reference data only (never reviewed trust).
   */
  public async effectiveForModel(
    row: ModelEvidence,
    features: readonly ClaimFeature[],
    context: EnforcementContext = { required: false },
  ): Promise<ReadonlyMap<ClaimFeature, EffectiveCompatibility>> {
    const identity = this.claimIdentityFor(row);
    const seed = seedHintForModel(row);
    const entries: [ClaimFeature, EffectiveCompatibility][] = [];
    for (const feature of features) {
      const claimKey = claimKeyFor(identity, feature);
      const [claim, decisions, records] = await Promise.all([
        this.options.claims.findEvidence(identity, feature),
        this.options.reviews.decisionsFor(claimKey, feature),
        this.options.quarantines.recordsFor(claimKey, feature),
      ]);
      if (claim === undefined) {
        entries.push([feature, this.seedAnswer(seed, claimKey, feature, context)]);
        continue;
      }
      entries.push([feature, this.resolve(claimKey, feature, claim, decisions, records, context)]);
    }
    return new Map(entries);
  }

  /** In-memory snapshot keyed by registry logicalId (for pure routing consumers). */
  public async snapshotForModels(
    rows: readonly ModelEvidence[],
    featuresFor: (row: ModelEvidence) => readonly ClaimFeature[],
    context: EnforcementContext = { required: true },
  ): Promise<EffectiveModelSnapshot> {
    const snapshot = new Map<string, ReadonlyMap<ClaimFeature, EffectiveCompatibility>>();
    for (const row of rows) {
      snapshot.set(row.logicalId, await this.effectiveForModel(row, featuresFor(row), context));
    }
    return snapshot;
  }

  /** Secret-free explanation for doctor/status diagnostics. */
  public async explain(row: ModelEvidence, features: readonly ClaimFeature[]): Promise<EffectiveCompatibilityExplanation> {
    const identity = this.claimIdentityFor(row);
    const effective = await this.effectiveForModel(row, features, { required: true });
    const explanation: EffectiveCompatibilityExplanation = Object.freeze({
      logicalId: row.logicalId,
      accessProviderId: row.identity.accessProviderId,
      physicalModelId: row.identity.upstreamModelId,
      claimIdentity: identity,
      seedState: row.compatibility.state,
      seedOnly: row.compatibility.claimRef === undefined,
      features: Object.freeze(Object.fromEntries(effective)),
    });
    assertSecretFree(explanation);
    return explanation;
  }

  /** Secret-free summary of durable authority state (counts + schema only). */
  public async summary(): Promise<Readonly<{
    policy: Readonly<{ supportedClientBaseline?: string; pinnedProtocolRevision?: string; pinnedFixtureRevision?: string; rlyBuildVersion?: string; allowQuarantineBypass: boolean }>;
    reviews: Awaited<ReturnType<ReviewDecisionStore["summary"]>>;
    quarantines: Awaited<ReturnType<QuarantineStore["summary"]>>;
  }>> {
    const [reviews, quarantines] = await Promise.all([
      this.options.reviews.summary(),
      this.options.quarantines.summary(),
    ]);
    return Object.freeze({
      policy: Object.freeze({
        ...(this.options.policy.supportedClientBaseline === undefined ? {} : { supportedClientBaseline: this.options.policy.supportedClientBaseline }),
        ...(this.options.policy.pinnedProtocolRevision === undefined ? {} : { pinnedProtocolRevision: this.options.policy.pinnedProtocolRevision }),
        ...(this.options.policy.pinnedFixtureRevision === undefined ? {} : { pinnedFixtureRevision: this.options.policy.pinnedFixtureRevision }),
        ...(this.options.policy.rlyBuildVersion === undefined ? {} : { rlyBuildVersion: this.options.policy.rlyBuildVersion }),
        allowQuarantineBypass: this.options.policy.allowQuarantineBypass ?? false,
      }),
      reviews,
      quarantines,
    });
  }

  private resolve(
    claimKey: string,
    feature: ClaimFeature,
    claim: CompatibilityClaimDocument | undefined,
    decisions: readonly import("./types.js").ReviewDecision[],
    records: readonly import("./types.js").QuarantineRecord[],
    context: EnforcementContext,
  ): EffectiveCompatibility {
    return resolveEffectiveCompatibility({
      claimKey,
      feature,
      ...(claim === undefined ? {} : { claim }),
      decisions,
      quarantines: records,
      policy: this.options.policy,
      required: context.required,
      experimentalOverride: context.experimentalOverride ?? false,
      allowQuarantineBypass: this.options.policy.allowQuarantineBypass ?? false,
      now: this.clock,
    });
  }

  /**
   * Seed-level fallback for a model with NO claim evidence: the legacy static
   * state derives `experimental` (never reviewed trust) or `broken` (hard
   * negative). `trusted-seed` rows point at a claim but cannot be trusted
   * without the claim + reviewed decision, so they derive `experimental` here.
   */
  private seedAnswer(
    seed: ReturnType<typeof seedHintForModel>,
    claimKey: string,
    feature: ClaimFeature,
    context: EnforcementContext,
  ): EffectiveCompatibility {
    const broken = seed === "broken";
    const effective = broken ? "untrusted" : "experimental";
    const enforcement = !context.required
      ? "allowed"
      : broken
        ? "blocked"
        : context.experimentalOverride === true
          ? "experimental-override"
          : "blocked";
    const result: EffectiveCompatibility = Object.freeze({
      claimKey,
      feature,
      effective,
      trust: "none",
      health: broken ? "failed" : "unknown",
      ...(broken ? { healthReason: "seed-broken-state" } : {}),
      freshness: "unknown",
      quarantine: "none",
      enforcement,
      ...(enforcement === "blocked"
        ? { enforcementReason: broken ? "seed-broken-fail-closed" : "seed-unreviewed-required-feature" }
        : enforcement === "experimental-override"
          ? { enforcementReason: "explicit-experimental-override" }
          : {}),
      layers: Object.freeze({ A: "missing", B: "missing", C: "missing" }),
      ...(broken ? { trustReason: "seed-broken-state" } : {}),
    });
    return result;
  }
}
