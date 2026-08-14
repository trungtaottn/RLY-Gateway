import type { CandidateAssessment } from "../eligibility/reasons.js";
import { quotaRank } from "./quota.js";

export function eligibleCandidates(
  candidates: readonly CandidateAssessment[],
  excludeAccountIds: ReadonlySet<string> = new Set(),
): CandidateAssessment[] {
  return candidates
    .filter((candidate) => candidate.eligible && !excludeAccountIds.has(candidate.accountId))
    .sort((left, right) => left.pinOrder - right.pinOrder);
}

export function orderByQuotaThenPin(candidates: readonly CandidateAssessment[]): CandidateAssessment[] {
  return [...candidates].sort((left, right) => {
    const rank = quotaRank(left.quotaClass) - quotaRank(right.quotaClass);
    return rank !== 0 ? rank : left.pinOrder - right.pinOrder;
  });
}

export function designatedPin(candidates: readonly CandidateAssessment[]): string | undefined {
  const ordered = [...candidates].sort((left, right) => left.pinOrder - right.pinOrder);
  return ordered[0]?.accountId;
}

export function selectManual(
  candidates: readonly CandidateAssessment[],
  pinnedAccountId: string | undefined,
  excludeAccountIds: ReadonlySet<string> = new Set(),
): CandidateAssessment | undefined {
  const pinId = pinnedAccountId ?? designatedPin(candidates);
  if (pinId === undefined || excludeAccountIds.has(pinId)) return undefined;
  return candidates.find((candidate) => candidate.accountId === pinId && candidate.eligible);
}

export function selectFillFirst(eligible: readonly CandidateAssessment[]): CandidateAssessment | undefined {
  return eligible[0];
}

export function selectRoundRobin(
  eligible: readonly CandidateAssessment[],
  cursor: number,
): Readonly<{ selected: CandidateAssessment; nextCursor: number }> | undefined {
  if (eligible.length === 0) return undefined;
  const index = ((cursor % eligible.length) + eligible.length) % eligible.length;
  const selected = eligible[index];
  if (selected === undefined) return undefined;
  return { selected, nextCursor: (index + 1) % eligible.length };
}
