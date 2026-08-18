/**
 * Execution commitment state model (#121).
 *
 * Commitment is tracked SEPARATELY from client-visible output. A provider can
 * commit billable/tool/session state before RLY has emitted a single client
 * byte, so retry/failover decisions must consume explicit commitment evidence
 * owned by the adapter/provider rails instead of only "did bytes reach the
 * client".
 *
 * PRIVACY INVARIANT: commitment state is secret-free metadata. It carries no
 * prompts, responses, reasoning text, tool payloads, credentials, or account
 * identity. It is safe to log and to place in retry traces.
 */
export type CommitmentState =
  /** The request body was never written to the transport; nothing can have committed. */
  | "not-sent"
  /** The request body was sent but no provider acknowledgement was received. */
  | "sent-unacknowledged"
  /** The provider acknowledged/committed the request (HTTP 2xx or a response started). */
  | "provider-accepted"
  /** Canonical output bytes started flowing toward the client path. */
  | "client-output-started"
  /** A tool call/arguments crossed the side-effect boundary. */
  | "tool-boundary"
  /** The outcome is ambiguous (e.g. network failure mid-flight); never replay. */
  | "unknown";

export const COMMITMENT_STATES: readonly CommitmentState[] = [
  "not-sent",
  "sent-unacknowledged",
  "provider-accepted",
  "client-output-started",
  "tool-boundary",
  "unknown",
] as const;

/**
 * A retry is safe ONLY when the policy can prove the previous attempt never
 * crossed a provider/client/tool commitment boundary. Only `not-sent`
 * satisfies that proof.
 */
export function commitmentAllowsRetry(state: CommitmentState): boolean {
  return state === "not-sent";
}

/** Ambiguous outcomes (unknown / sent-unacknowledged) default to no replay. */
export function isAmbiguousCommitment(state: CommitmentState): boolean {
  return state === "unknown" || state === "sent-unacknowledged";
}

/** Deterministic total order used for diagnostics ("how far did this attempt get"). */
const COMMITMENT_RANK: Readonly<Record<CommitmentState, number>> = Object.freeze({
  "not-sent": 0,
  "sent-unacknowledged": 1,
  "provider-accepted": 2,
  "client-output-started": 3,
  "tool-boundary": 4,
  unknown: 5,
});

export function commitmentRank(state: CommitmentState): number {
  return COMMITMENT_RANK[state];
}

/** True when `state` is at or past provider acceptance (the provider committed). */
export function isProviderCommitted(state: CommitmentState): boolean {
  return commitmentRank(state) >= COMMITMENT_RANK["provider-accepted"];
}
