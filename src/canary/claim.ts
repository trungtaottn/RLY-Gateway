import { createHash } from "node:crypto";
import { z } from "zod";
import type { ClientKind, EndpointContract, EvidenceLayer, EvidenceResult, AuthMode, ClaimSourceProtocol } from "./types.js";
import { ENDPOINT_CONTRACTS } from "./types.js";
import type { CanaryGate } from "./types.js";
import { CANARY_GATES } from "./types.js";

/**
 * Compatibility Claim and Evidence v2 (#122 / W2-T1).
 *
 * Replaces the coarse `livePassed: boolean` classification input with a
 * versioned, feature-scoped Compatibility Claim + Evidence model keyed to the
 * exact execution path (client, exact client version/baseline, source
 * protocol/revision, adapter/integration surface, access provider, auth mode,
 * endpoint contract, exact physical model, feature/capability claim).
 *
 * Evidence layers:
 * - `A` — deterministic protocol/adapter conformance with fake/synthetic
 *   fixtures (the current canary gate matrix is reclassified as Layer A).
 * - `B` — exact installed-client black-box behavior (#123 runner, not built).
 * - `C` — exact real access-path live verification (#123 runner, not built).
 *
 * Hard invariants:
 * - Evidence artifacts NEVER contain credentials, auth headers, account
 *   identity, prompts, real responses, or reasoning text.
 * - Missing/skipped/unrun evidence is DISTINCT from PASS and FAIL
 *   (`missing`/`not-run`).
 * - A deterministic Layer A pass never implies live/production trust.
 * - No cross-provider/model/feature claim reuse: the claim key includes the
 *   full identity plus the feature.
 * - Legacy v1 canary outputs are legacy/untrusted for v2 authority decisions
 *   until explicitly re-observed.
 */

export const CLAIM_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_SCHEMA_VERSION = 2 as const;

/** Pinned runner/tool identity that produced the evidence. */
export const CANARY_RUNNER_VERSION = "rly-canary-runner/2.0" as const;

/** Features a compatibility claim can be scoped to (per-path, independent). */
export type ClaimFeature = CanaryGate | "config-overlay";

export const CLAIM_FEATURES: readonly ClaimFeature[] = Object.freeze([
  ...CANARY_GATES,
  "config-overlay",
]);

/** Evidence kinds per layer (#122). */
export type EvidenceKind = "deterministic-fake-matrix" | "installed-client" | "live-access-path";

export const EVIDENCE_LAYERS: readonly EvidenceLayer[] = Object.freeze(["A", "B", "C"]);

export const CLAIM_FEATURE_VALUES = [...CLAIM_FEATURES] as [ClaimFeature, ...ClaimFeature[]];

/**
 * Stable, versioned claim identity for one exact execution path. Model family
 * is classification metadata only and never part of the canonical key: the
 * key is built exclusively from exact client/protocol/adapter/provider/auth/
 * endpoint/model/feature identity.
 */
export type CompatibilityClaimIdentity = Readonly<{
  client: ClientKind;
  /** Exact tested client version/baseline, e.g. `claude-code-2.1.229`. */
  clientVersion: string;
  /** Client-facing source protocol (#119 fidelity vocabulary). */
  sourceProtocol: ClaimSourceProtocol;
  /** Pinned client-contract/protocol revision (fixture corpus). */
  protocolRevision: string;
  /** Adapter/integration surface, e.g. `codex-oauth`. */
  adapterId: string;
  accessProviderId: string;
  authMode: AuthMode;
  endpointContract: EndpointContract;
  physicalModelId: string;
  /** Classification metadata ONLY — never part of the claim key. */
  modelFamily?: string;
}>;

/** One feature-scoped Evidence Artifact v2 observation. */
export type EvidenceArtifactV2 = Readonly<{
  claimKey: string;
  feature: ClaimFeature;
  layer: EvidenceLayer;
  kind: EvidenceKind;
  /** Fixture/corpus revision the observation ran against. */
  fixtureRevision: string;
  /** Test runner/tool version that produced the observation. */
  runnerVersion: string;
  checkedAt: string;
  result: EvidenceResult;
  /** Typed failure category when failed/not-run (e.g. `missing-agent-header`). */
  failureReason?: string;
  /** Environment/platform metadata needed for interpretation. */
  environment?: Readonly<{ platform: string; nodeVersion: string }>;
  /** Safe reference to raw machine-readable results (path, never content). */
  ref?: string;
}>;

/** Versioned, append/audit-friendly document for ONE (identity, feature) claim. */
export type CompatibilityClaimDocument = Readonly<{
  schemaVersion: typeof CLAIM_SCHEMA_VERSION;
  claimKey: string;
  claimIdentity: CompatibilityClaimIdentity;
  feature: ClaimFeature;
  /** Append-only observation history; records are never silently rewritten. */
  records: readonly EvidenceArtifactV2[];
}>;

/** Overall status of a claim derived from its observation history. */
export type ClaimStatus = "missing" | "not-run" | "passed" | "failed";

export const LEGACY_V1_POLICY =
  "legacy-v1-artifact-untrusted-for-v2-claims" as const;

/** Authentication mode for one adapter/integration surface (identity input). */
export function authModeForAdapter(adapterId: string): AuthMode {
  switch (adapterId) {
    case "codex-oauth": return "oauth";
    case "cline-interop": return "interop-import";
    case "openrouter-direct":
    case "deepseek-direct": return "direct-api-key";
    default: return "unknown";
  }
}

/** Client-facing endpoint contract for one client kind (identity input). */
export function endpointContractForClient(client: ClientKind): EndpointContract {
  return client === "claude-code" ? "anthropic-messages" : "openai-responses";
}

/**
 * Layers required before a claim for this adapter can be considered satisfied.
 * Every shipped adapter requires full Layer A (deterministic), B (installed
 * client), and C (live access path) evidence; unknown adapters fail closed the
 * same way. This is the single place a future adapter that does not need live
 * proof would be registered. Layer B/C runners are owned by #123; promotion of
 * a satisfied claim to trusted registry state is owned by #124.
 */
export function requiredLayersForAdapter(adapterId: string): readonly EvidenceLayer[] {
  switch (adapterId) {
    case "codex-oauth":
    case "cline-interop":
    case "openrouter-direct":
    case "deepseek-direct":
      return Object.freeze(["A", "B", "C"]);
    default:
      // Unknown adapters fail closed: full Layer A/B/C proof is required.
      return Object.freeze(["A", "B", "C"]);
  }
}

/** Canonical, versioned claim key for one (identity, feature). Deterministic. */
export function claimKeyFor(identity: CompatibilityClaimIdentity, feature: ClaimFeature): string {
  const parts = [
    "v2",
    identity.client,
    identity.clientVersion,
    identity.sourceProtocol,
    identity.protocolRevision,
    identity.adapterId,
    identity.accessProviderId,
    identity.authMode,
    identity.endpointContract,
    identity.physicalModelId,
    feature,
  ];
  for (const part of parts) {
    if (typeof part !== "string" || part.length === 0 || part.includes("|")) {
      throw new Error("claim key parts must be non-empty strings without '|'");
    }
  }
  return parts.join("|");
}

/** Stable sha-256 hex of a claim key (deterministic, for file naming). */
export function claimKeyHash(claimKey: string): string {
  return createHash("sha256").update(claimKey, "utf8").digest("hex");
}

/** Maps a gate status to an evidence result (`missing` is record absence). */
export function gateStatusToResult(status: "passed" | "failed" | "not-run"): EvidenceResult {
  return status;
}

/** Per-layer status of a claim; a layer with no record is `missing`. */
export function layerStatuses(doc: CompatibilityClaimDocument): Readonly<Record<EvidenceLayer, ClaimStatus>> {
  const byLayer = new Map<EvidenceLayer, EvidenceArtifactV2[]>();
  for (const record of doc.records) {
    const list = byLayer.get(record.layer) ?? [];
    list.push(record);
    byLayer.set(record.layer, list);
  }
  const status = (records: readonly EvidenceArtifactV2[]): ClaimStatus => {
    if (records.length === 0) return "missing";
    if (records.some((record) => record.result === "failed")) return "failed";
    if (records.some((record) => record.result === "passed")) return "passed";
    return "not-run";
  };
  return Object.freeze({
    A: status(byLayer.get("A") ?? []),
    B: status(byLayer.get("B") ?? []),
    C: status(byLayer.get("C") ?? []),
  });
}

/**
 * Overall claim status derived from the observation history. A claim is:
 * - `missing` when it has no observations at all;
 * - `failed` when any observation failed (evidence of brokenness);
 * - `not-run` when a REQUIRED layer has no passing observation (missing/skipped
 *   evidence is never conflated with PASS);
 * - `passed` only when every required layer is present with a passing record.
 */
export function claimStatusFor(doc: CompatibilityClaimDocument): ClaimStatus {
  if (doc.records.length === 0) return "missing";
  if (doc.records.some((record) => record.result === "failed")) return "failed";
  const required = requiredLayersForAdapter(doc.claimIdentity.adapterId);
  const present = new Set(doc.records.map((record) => record.layer));
  if (!required.every((layer) => present.has(layer))) return "not-run";
  if (doc.records.some((record) => record.result === "passed")) return "passed";
  return "not-run";
}

/**
 * Appends an observation to a claim document. Existing records are never
 * modified or reordered (append/audit-friendly); exact duplicate observations
 * are idempotent no-ops so re-running an identical canary does not duplicate
 * records.
 */
export function appendObservation(
  doc: CompatibilityClaimDocument,
  record: EvidenceArtifactV2,
): CompatibilityClaimDocument {
  if (doc.records.some((existing) => sameObservation(existing, record))) return doc;
  return Object.freeze({
    ...doc,
    records: Object.freeze([...doc.records, record]),
  });
}

function sameObservation(left: EvidenceArtifactV2, right: EvidenceArtifactV2): boolean {
  return left.layer === right.layer
    && left.kind === right.kind
    && left.result === right.result
    && left.failureReason === right.failureReason
    && left.runnerVersion === right.runnerVersion
    && left.checkedAt === right.checkedAt
    && left.fixtureRevision === right.fixtureRevision
    && left.ref === right.ref
    && JSON.stringify(left.environment) === JSON.stringify(right.environment);
}

/** Creates an empty claim document for one (identity, feature). */
export function emptyClaimDocument(
  claimIdentity: CompatibilityClaimIdentity,
  feature: ClaimFeature,
): CompatibilityClaimDocument {
  const claimKey = claimKeyFor(claimIdentity, feature);
  return Object.freeze({
    schemaVersion: CLAIM_SCHEMA_VERSION,
    claimKey,
    claimIdentity,
    feature,
    records: Object.freeze([]),
  });
}

/** Builds a claim identity from canary-run inputs (Layer A observations). */
export function claimIdentityFor(input: Readonly<{
  client: ClientKind;
  clientVersion: string;
  contract: Readonly<{ fixtureRevision: string }>;
  adapterId: string;
  accessProviderId: string;
  physicalModelId: string;
  modelFamily?: string;
}>): CompatibilityClaimIdentity {
  return Object.freeze({
    client: input.client,
    clientVersion: input.clientVersion,
    sourceProtocol: endpointContractForClient(input.client),
    protocolRevision: input.contract.fixtureRevision,
    adapterId: input.adapterId,
    accessProviderId: input.accessProviderId,
    authMode: authModeForAdapter(input.adapterId),
    endpointContract: endpointContractForClient(input.client),
    physicalModelId: input.physicalModelId,
    ...(input.modelFamily === undefined ? {} : { modelFamily: input.modelFamily }),
  });
}

// ---------------------------------------------------------------------------
// Zod persistence schemas (fail-closed reads)
// ---------------------------------------------------------------------------

export const evidenceArtifactV2Schema = z.object({
  claimKey: z.string().min(1),
  feature: z.enum(CLAIM_FEATURE_VALUES),
  layer: z.enum(["A", "B", "C"]),
  kind: z.enum(["deterministic-fake-matrix", "installed-client", "live-access-path"]),
  fixtureRevision: z.string().min(1),
  runnerVersion: z.string().min(1),
  checkedAt: z.string().min(1),
  result: z.enum(["passed", "failed", "not-run"]),
  failureReason: z.string().optional(),
  environment: z.object({ platform: z.string(), nodeVersion: z.string() }).optional(),
  ref: z.string().optional(),
});

export const compatibilityClaimDocumentSchema = z.object({
  schemaVersion: z.literal(CLAIM_SCHEMA_VERSION),
  claimKey: z.string().min(1),
  claimIdentity: z.object({
    client: z.enum(["claude-code", "codex-cli"]),
    clientVersion: z.string().min(1),
    sourceProtocol: z.enum(ENDPOINT_CONTRACTS),
    protocolRevision: z.string().min(1),
    adapterId: z.string().min(1),
    accessProviderId: z.string().min(1),
    authMode: z.enum(["oauth", "direct-api-key", "interop-import", "bridge", "unknown"]),
    endpointContract: z.enum(ENDPOINT_CONTRACTS),
    physicalModelId: z.string().min(1),
    modelFamily: z.string().optional(),
  }),
  feature: z.enum(CLAIM_FEATURE_VALUES),
  records: z.array(evidenceArtifactV2Schema),
});

// ---------------------------------------------------------------------------
// Legacy v1 policy (#122)
// ---------------------------------------------------------------------------

/** True when a parsed canary summary is a v2 evidence run (schema version 2). */
export function isV2EvidenceSummary(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object") return false;
  const candidate = parsed as Readonly<{ evidenceSchemaVersion?: unknown }>;
  return candidate.evidenceSchemaVersion === EVIDENCE_SCHEMA_VERSION;
}

/** True when a parsed document is a v2 claim document (fail-closed read). */
export function isV2ClaimDocument(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object") return false;
  const candidate = parsed as Readonly<{ schemaVersion?: unknown; claimKey?: unknown; records?: unknown }>;
  return candidate.schemaVersion === CLAIM_SCHEMA_VERSION
    && typeof candidate.claimKey === "string"
    && Array.isArray(candidate.records);
}

/**
 * Explicit legacy policy for pre-v2 outputs (#122): a v1 canary artifact is
 * readable for diagnostics but is UNTRUSTED for v2 authority decisions. It can
 * never satisfy a stronger v2 claim — a claim lookup returns `missing` until a
 * v2 observation records real evidence. There is no silent auto-migration.
 */
export function legacyPolicyNote(parsed: unknown): Readonly<{ legacy: boolean; reason?: string }> {
  if (isV2EvidenceSummary(parsed) || isV2ClaimDocument(parsed)) {
    return Object.freeze({ legacy: false });
  }
  return Object.freeze({ legacy: true, reason: LEGACY_V1_POLICY });
}
