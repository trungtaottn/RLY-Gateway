import type { ReviewDecision, ReviewDecisionKind } from "./types.js";

/**
 * Review Decision Store — pure logic (#124).
 *
 * Positive trust requires an explicit reviewed decision; a new PASS
 * observation does not auto-promote. Decisions are keyed to exact claim
 * identities + evidence revisions. `latestDecision` selects the newest
 * decision by `decisionRevision`; `decisionCovers` verifies the decision was
 * made against the current evidence snapshot.
 */

/** Latest decision for one (claimKey, feature), by decision revision. */
export function latestDecision(decisions: readonly ReviewDecision[]): ReviewDecision | undefined {
  return decisions.reduce<ReviewDecision | undefined>(
    (latest, decision) => latest === undefined || decision.decisionRevision > latest.decisionRevision ? decision : latest,
    undefined,
  );
}

/** Latest decision of a specific kind (used for quarantine/reject precedence). */
export function latestDecisionOfKind(
  decisions: readonly ReviewDecision[],
  kind: ReviewDecisionKind,
): ReviewDecision | undefined {
  return decisions.reduce<ReviewDecision | undefined>(
    (latest, decision) => decision.decision === kind
      && (latest === undefined || decision.decisionRevision > latest.decisionRevision)
      ? decision
      : latest,
    undefined,
  );
}

/** True when the decision was made against exactly the current evidence snapshot. */
export function decisionCovers(
  decision: ReviewDecision | undefined,
  evidenceRevision: string,
): decision is ReviewDecision {
  return decision !== undefined && decision.evidenceRevision === evidenceRevision;
}

/** Next monotonic decision revision for a (claimKey, feature) history. */
export function nextDecisionRevision(decisions: readonly ReviewDecision[]): number {
  return decisions.reduce((max, decision) => Math.max(max, decision.decisionRevision), 0) + 1;
}
