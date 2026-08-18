import { assertSecretFree } from "../../control-plane/secret-free.js";
import type { PoolStrategy } from "../../control-plane/types.js";
import type { CandidateAssessment, EligibilityReason } from "./reasons.js";

export type TraceCandidate = Readonly<{
  accountPseudonym: string;
  eligible: boolean;
  reasons: readonly EligibilityReason[];
}>;

export type DecisionTrace = Readonly<{
  requestId: string;
  policyRevision: number;
  policyHash: string;
  strategy: PoolStrategy;
  sourceRule: string;
  candidates: readonly TraceCandidate[];
  selected?: Readonly<{ accountPseudonym: string; credentialGeneration: number }>;
  decidedAt: string;
}>;

export function toTraceCandidates(candidates: readonly CandidateAssessment[]): readonly TraceCandidate[] {
  return candidates.map((candidate) => ({
    accountPseudonym: candidate.accountPseudonym,
    eligible: candidate.eligible,
    reasons: [...candidate.reasons],
  }));
}

export function createDecisionTrace(trace: DecisionTrace): DecisionTrace {
  const frozen: DecisionTrace = Object.freeze({
    requestId: trace.requestId,
    policyRevision: trace.policyRevision,
    policyHash: trace.policyHash,
    strategy: trace.strategy,
    sourceRule: trace.sourceRule,
    candidates: Object.freeze(trace.candidates.map((candidate) => Object.freeze({
      accountPseudonym: candidate.accountPseudonym,
      eligible: candidate.eligible,
      reasons: Object.freeze([...candidate.reasons]),
    }))),
    decidedAt: trace.decidedAt,
    ...(trace.selected === undefined ? {} : { selected: Object.freeze({ ...trace.selected }) }),
  });
  assertSecretFree(frozen);
  return frozen;
}
