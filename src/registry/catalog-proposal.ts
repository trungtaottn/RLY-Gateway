import { z } from "zod";
import {
  directProviderRegistry,
  findModelEvidence,
  modelsForProvider,
  type DiscoveryCandidate,
  type DiscoverySnapshot,
  type ModelEvidence,
  type ModelIdentity,
  type ModelLimits,
  type RegistryDocument,
} from "./model-registry.js";

/**
 * Propose-only catalog drift engine (#23 / BL-042).
 *
 * Diffs a provider catalogue `DiscoverySnapshot` against the reviewed #67
 * trusted registry and returns a deterministic `CatalogProposalReport`. This
 * module is pure: it never writes to, mutates, or activates trusted evidence,
 * profile tier mappings, `/v1/models` projections, or active session policy.
 * Promotion of proposed evidence is a separate reviewed control-plane
 * operation owned by later issues (#69/#72).
 */

export type DeclaredMetadataField =
  | "modelFamily"
  | "contextWindow"
  | "maxOutput"
  | "tools"
  | "reasoning";

export type DeclaredMetadataChange = Readonly<{
  field: DeclaredMetadataField;
  /** Reviewed/trusted value; omitted when the reviewed entry has no evidence for the field. */
  trusted?: string | number | boolean;
  /** Discovered/declared value from the snapshot; omitted when the snapshot did not declare it. */
  observed?: string | number | boolean;
}>;

export type ChangedCandidate = Readonly<{
  logicalId: string;
  identity: ModelIdentity;
  /** Per-field declared/observed drift vs reviewed evidence. */
  changes: readonly DeclaredMetadataChange[];
}>;

export type RemovedModel = Readonly<{
  logicalId: string;
  identity: ModelIdentity;
  /** Snapshot timestamp that observed the model absent. */
  observedAt: string;
  reason: "not-in-snapshot";
}>;

/** A new candidate surfaced by discovery but with no trusted exact evidence. */
export type NewCandidateProposal = Readonly<{
  identity: ModelIdentity;
  proposedAt: string;
  reason: "no-exact-evidence";
  observedLimits?: ModelLimits;
  declared?: DiscoveryCandidate["declared"];
}>;

export type CatalogProposalReport = Readonly<{
  providerId: string;
  source: string;
  discoveredAt: string;
  catalogueVersion?: string;
  /** Trusted registry revision this report was diffed against. */
  registryRevision: number;
  /** Exact trusted access paths present in the snapshot. Deterministic order. */
  unchanged: readonly ModelEvidence[];
  /** In the snapshot with no trusted exact evidence. Never auto-activated. */
  new: readonly NewCandidateProposal[];
  /** Exact trusted paths whose declared/observed metadata drifted from reviewed evidence. */
  changed: readonly ChangedCandidate[];
  /** Trusted provider models absent from the snapshot. Drift only; never deleted or substituted. */
  removed: readonly RemovedModel[];
  /**
   * Reviewed evidence references only (from known/unchanged entries). Never
   * fabricated; skipped/unrun #24 canary tests are never represented as a pass.
   */
  compatibilityEvidenceRefs: readonly string[];
}>;

/**
 * Diff one provider's discovery snapshot against reviewed evidence.
 *
 * Determinism contract: every array is sorted by `logicalId`; the snapshot
 * timestamp and catalogue version are inputs, so identical input yields an
 * identical report on repeated runs.
 *
 * Fail-closed contract: a snapshot must be single-provider for the requested
 * access provider, and a snapshot with duplicate access paths is rejected
 * rather than silently de-duplicated.
 */
export function proposeCatalogDrift(
  snapshot: DiscoverySnapshot,
  providerId: string,
  registry: RegistryDocument = directProviderRegistry,
): CatalogProposalReport {
  for (const candidate of snapshot.models) {
    if (candidate.accessProviderId !== providerId) {
      throw new Error(`discovery snapshot mixes access providers (expected ${providerId}, found ${candidate.accessProviderId})`);
    }
  }

  const seen = new Set<string>();
  const candidatesByUpstreamId = new Map<string, DiscoveryCandidate>();
  for (const candidate of snapshot.models) {
    if (seen.has(candidate.upstreamModelId)) {
      throw new Error(`discovery snapshot contains duplicate access path ${providerId}/${candidate.upstreamModelId}`);
    }
    seen.add(candidate.upstreamModelId);
    candidatesByUpstreamId.set(candidate.upstreamModelId, candidate);
  }

  const trusted = modelsForProvider(registry, providerId);
  const unchanged: ModelEvidence[] = [];
  const newCandidates: NewCandidateProposal[] = [];
  const changed: ChangedCandidate[] = [];
  const removed: RemovedModel[] = [];
  const reviewedEvidenceRefs = new Set<string>();

  for (const evidence of trusted) {
    const candidate = candidatesByUpstreamId.get(evidence.identity.upstreamModelId);
    if (candidate === undefined) {
      removed.push(Object.freeze({
        logicalId: evidence.logicalId,
        identity: evidence.identity,
        observedAt: snapshot.discoveredAt,
        reason: "not-in-snapshot" as const,
      }));
      continue;
    }
    reviewedEvidenceRefs.add(evidence.compatibility.evidenceRef);
    const changes = metadataChanges(evidence, candidate);
    if (changes.length === 0) unchanged.push(evidence);
    else changed.push(Object.freeze({ logicalId: evidence.logicalId, identity: evidence.identity, changes: Object.freeze(changes) }));
  }

  for (const candidate of snapshot.models) {
    const evidence = findModelEvidence(registry, candidate.accessProviderId, candidate.upstreamModelId);
    if (evidence) continue; // handled above as unchanged or changed
    newCandidates.push(Object.freeze({
      identity: Object.freeze({
        accessProviderId: candidate.accessProviderId,
        upstreamModelId: candidate.upstreamModelId,
        ...(candidate.modelFamily === undefined ? {} : { modelFamily: candidate.modelFamily }),
      }),
      proposedAt: snapshot.discoveredAt,
      reason: "no-exact-evidence" as const,
      ...(candidate.observedLimits === undefined ? {} : { observedLimits: Object.freeze(candidate.observedLimits) }),
      ...(candidate.declared === undefined ? {} : { declared: Object.freeze(candidate.declared) }),
    }));
  }

  const byLogicalId = (left: { logicalId: string }, right: { logicalId: string }): number =>
    left.logicalId < right.logicalId ? -1 : left.logicalId > right.logicalId ? 1 : 0;
  const byAccessPath = (left: { identity: ModelIdentity }, right: { identity: ModelIdentity }): number => {
    const leftId = `${left.identity.accessProviderId}/${left.identity.upstreamModelId}`;
    const rightId = `${right.identity.accessProviderId}/${right.identity.upstreamModelId}`;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  };
  unchanged.sort(byLogicalId);
  newCandidates.sort(byAccessPath);
  changed.sort(byLogicalId);
  removed.sort(byLogicalId);

  return Object.freeze({
    providerId,
    source: snapshot.source,
    discoveredAt: snapshot.discoveredAt,
    ...(snapshot.catalogueVersion === undefined ? {} : { catalogueVersion: snapshot.catalogueVersion }),
    registryRevision: registry.registryRevision,
    unchanged: Object.freeze(unchanged),
    new: Object.freeze(newCandidates),
    changed: Object.freeze(changed),
    removed: Object.freeze(removed),
    compatibilityEvidenceRefs: Object.freeze([...reviewedEvidenceRefs].sort()),
  });
}

function metadataChanges(evidence: ModelEvidence, candidate: DiscoveryCandidate): DeclaredMetadataChange[] {
  const changes: DeclaredMetadataChange[] = [];
  const observedFamily = candidate.modelFamily;
  if (observedFamily !== undefined && observedFamily !== evidence.identity.modelFamily) {
    changes.push(fieldChange("modelFamily", evidence.identity.modelFamily, observedFamily));
  }
  const observedContextWindow = candidate.declared?.contextWindow ?? candidate.observedLimits?.contextWindow;
  if (observedContextWindow !== undefined && observedContextWindow !== evidence.limits.contextWindow) {
    changes.push(fieldChange("contextWindow", evidence.limits.contextWindow, observedContextWindow));
  }
  const observedMaxOutput = candidate.declared?.maxOutput ?? candidate.observedLimits?.maxOutput;
  if (observedMaxOutput !== undefined && observedMaxOutput !== evidence.limits.maxOutput) {
    changes.push(fieldChange("maxOutput", evidence.limits.maxOutput, observedMaxOutput));
  }
  if (candidate.declared?.tools !== undefined && candidate.declared.tools !== evidence.capabilities.tools) {
    changes.push(fieldChange("tools", evidence.capabilities.tools, candidate.declared.tools));
  }
  if (candidate.declared?.reasoning !== undefined && candidate.declared.reasoning !== evidence.capabilities.reasoning) {
    changes.push(fieldChange("reasoning", evidence.capabilities.reasoning, candidate.declared.reasoning));
  }
  return changes;
}

function fieldChange(field: DeclaredMetadataField, trusted: string | number | boolean | undefined, observed: string | number | boolean): DeclaredMetadataChange {
  return Object.freeze({
    field,
    ...(trusted === undefined ? {} : { trusted }),
    observed,
  });
}

// ---------------------------------------------------------------------------
// Artifact schemas
// The persisted proposal artifact is metadata-only and schema-validated on
// read (fail-closed), consistent with the control-plane conventions.
// ---------------------------------------------------------------------------

const identitySchema = z.object({
  accessProviderId: z.string().min(1),
  upstreamModelId: z.string().min(1),
  modelFamily: z.string().min(1).optional(),
});

const limitsSchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
});

const declaredSchema = z.object({
  tools: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
});

const compatibilitySchema = z.object({
  state: z.enum(["VERIFIED", "EXPERIMENTAL", "BROKEN"]),
  baseline: z.string().min(1),
  evidenceRef: z.string().min(1),
  checkedAt: z.string().min(1),
});

const capabilitiesSchema = z.object({
  streaming: z.boolean(),
  tools: z.boolean(),
  parallelTools: z.boolean(),
  images: z.boolean(),
  reasoning: z.boolean(),
  redactedReasoning: z.boolean(),
  structuredOutput: z.boolean(),
  tokenCounting: z.enum(["upstream", "exact-local", "conservative-estimate", "unsupported"]),
});

const reasoningSchema = z.object({
  supported: z.boolean(),
  controlKind: z.enum(["discrete-effort", "adaptive", "binary", "token-budget", "none"]),
  effortLevels: z.array(z.string()).readonly().optional(),
  adaptive: z.boolean(),
  tokenBudget: z.boolean(),
  reasoningWithTools: z.boolean(),
});

const evidenceSchema = z.object({
  logicalId: z.string().min(1),
  identity: identitySchema,
  verifiedAt: z.string().min(1),
  fixtureVersion: z.string().min(1),
  tokenCounting: z.enum(["upstream", "exact-local", "conservative-estimate", "unsupported"]),
  capabilities: capabilitiesSchema,
  limits: limitsSchema,
  reasoning: reasoningSchema,
  compatibility: compatibilitySchema,
});

const changeSchema = z.object({
  field: z.enum(["modelFamily", "contextWindow", "maxOutput", "tools", "reasoning"]),
  trusted: z.union([z.string(), z.number(), z.boolean()]).optional(),
  observed: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const newCandidateSchema = z.object({
  identity: identitySchema,
  proposedAt: z.string().min(1),
  reason: z.literal("no-exact-evidence"),
  observedLimits: limitsSchema.optional(),
  declared: declaredSchema.optional(),
});

const changedSchema = z.object({
  logicalId: z.string().min(1),
  identity: identitySchema,
  changes: z.array(changeSchema).readonly(),
});

const removedSchema = z.object({
  logicalId: z.string().min(1),
  identity: identitySchema,
  observedAt: z.string().min(1),
  reason: z.literal("not-in-snapshot"),
});

/** Validates a persisted `CatalogProposalReport` artifact. Fail-closed on malformed files. */
export const catalogProposalReportSchema = z.object({
  providerId: z.string().min(1),
  source: z.string().min(1),
  discoveredAt: z.string().min(1),
  catalogueVersion: z.string().min(1).optional(),
  registryRevision: z.number().int().nonnegative(),
  unchanged: z.array(evidenceSchema).readonly(),
  new: z.array(newCandidateSchema).readonly(),
  changed: z.array(changedSchema).readonly(),
  removed: z.array(removedSchema).readonly(),
  compatibilityEvidenceRefs: z.array(z.string().min(1)).readonly(),
});

/** Validates a raw discovery snapshot shape before it enters the drift engine. */
export const discoverySnapshotSchema = z.object({
  source: z.string().min(1),
  discoveredAt: z.string().min(1),
  catalogueVersion: z.string().min(1).optional(),
  models: z.array(z.object({
    accessProviderId: z.string().min(1),
    upstreamModelId: z.string().min(1),
    modelFamily: z.string().min(1).optional(),
    observedLimits: limitsSchema.optional(),
    declared: declaredSchema.optional(),
  })).readonly(),
});

export type DiscoverySnapshotInput = z.input<typeof discoverySnapshotSchema>;
