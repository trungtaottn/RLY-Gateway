import type {
  CompatibilityState,
  ModelEvidence,
  RegistryDocument,
} from "../registry/model-registry.js";
import type { CanaryEvidence, CanaryVerdict } from "./types.js";

/**
 * Canary → registry proposal boundary (#24 / #23 / #67).
 *
 * The canary REPORTS evidence and drift; it never mutates the trusted registry
 * (`directProviderRegistry`) or the trusted tier mappings. `proposeCanaryState`
 * diffs canary evidence against reviewed entries and returns proposed
 * compatibility states for the #23 review workflow. Promotion of a proposed
 * state to trusted evidence remains an explicit repository/control-plane
 * action.
 */

export type CanaryProposal = Readonly<{
  accessProviderId: string;
  physicalModelId: string;
  modelFamily?: string;
  /** Current trusted state, or undefined when the path is not in the registry. */
  currentState?: CompatibilityState;
  /** State the canary evidence supports for this exact path. */
  proposedState: CompatibilityState;
  evidenceRef: string;
  clientVersion: string;
  checkedAt: string;
  reason?: string;
}>;

/** Maps a canary verdict onto the trusted registry states (#72 gate). */
export function verdictToCompatibilityState(verdict: CanaryVerdict): CompatibilityState | undefined {
  switch (verdict) {
    case "VERIFIED": return "VERIFIED";
    case "EXPERIMENTAL": return "EXPERIMENTAL";
    case "BROKEN": return "BROKEN";
    case "unknown": return undefined;
  }
}

/**
 * Diffs one canary evidence record against the trusted registry and returns a
 * deterministic proposal. Exact `(accessProviderId, physicalModelId)` matching
 * only: the same upstream model through two access providers never reuses
 * evidence. The registry document is never written.
 */
export function proposeCanaryState(
  evidence: CanaryEvidence,
  registry: RegistryDocument,
): CanaryProposal | undefined {
  const current = registry.models.find(
    (model) => model.identity.accessProviderId === evidence.accessProviderId
      && model.identity.upstreamModelId === evidence.physicalModelId,
  );
  const proposedState = verdictToCompatibilityState(evidence.verdict);
  if (proposedState === undefined) return undefined;
  return Object.freeze({
    accessProviderId: evidence.accessProviderId,
    physicalModelId: evidence.physicalModelId,
    ...(evidence.modelFamily === undefined ? {} : { modelFamily: evidence.modelFamily }),
    ...(current === undefined ? {} : { currentState: current.compatibility.state }),
    proposedState,
    evidenceRef: evidence.evidenceKind === "live"
      ? `canary-live:${evidence.fixtureRevision}`
      : `canary-fake:${evidence.fixtureRevision}`,
    clientVersion: evidence.clientVersion,
    checkedAt: evidence.checkedAt,
    ...(evidence.reason === undefined ? {} : { reason: evidence.reason }),
  });
}

/**
 * Returns the compatibility state the #72 projection gate should use for an
 * access path given canary evidence: VERIFIED by default, EXPERIMENTAL only
 * with the explicit opt-in, BROKEN/unreviewed never. Mirrors the projection
 * policy so canary output is directly consumable by the gate.
 */
export function projectionStateForEvidence(evidence: ModelEvidence): CompatibilityState {
  return evidence.compatibility.state;
}
