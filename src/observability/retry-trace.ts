import type { CommitmentState } from "../providers/commitment.js";
import type { ProviderStatusClass } from "../providers/provider-error.js";
import { statusClassOf } from "../providers/provider-error.js";
import { ProviderAdapterError } from "../providers/provider-adapter.js";
import type { CanonicalEvent } from "../core/canonical-event.js";
import type { RouteOutcomeClass } from "../control-plane/health/types.js";

/**
 * Retry/error observability (#121): trace ONLY allowlisted categories —
 * provider/access path, status class, retryability reason, commitment state,
 * attempt number, and terminal reason. The output object's key set is fixed;
 * no credential, prompt/response/reasoning/tool payload content, raw account
 * identity, or unredacted secret-bearing error body can enter it by
 * construction.
 */
export type RetryTrace = Readonly<{
  requestId: string;
  providerId: string;
  adapterId: string;
  modelId: string;
  attempt: number;
  statusClass: ProviderStatusClass;
  commitment: CommitmentState;
  retryable: boolean;
  retryReason?: string;
  terminalReason?: string;
  outcome?: RouteOutcomeClass;
}>;

const ALLOWED_KEYS = new Set<keyof RetryTrace>([
  "requestId", "providerId", "adapterId", "modelId", "attempt",
  "statusClass", "commitment", "retryable", "retryReason", "terminalReason", "outcome",
]);

export function retryTrace(input: Readonly<{
  requestId: string;
  providerId: string;
  adapterId: string;
  modelId: string;
  attempt: number;
  commitment: CommitmentState;
  statusCode?: number;
  retryable: boolean;
  retryReason?: string;
  terminalReason?: string;
  outcome?: RouteOutcomeClass;
}>): RetryTrace {
  return Object.freeze({
    requestId: input.requestId,
    providerId: input.providerId,
    adapterId: input.adapterId,
    modelId: input.modelId,
    attempt: input.attempt,
    statusClass: statusClassOf(input.statusCode ?? 0),
    commitment: input.commitment,
    retryable: input.retryable,
    ...(input.retryReason === undefined ? {} : { retryReason: input.retryReason }),
    ...(input.terminalReason === undefined ? {} : { terminalReason: input.terminalReason }),
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
  });
}

/** Deterministic retryability reason for an error, keyed on safe metadata. */
export function retryReasonOf(error: unknown): Readonly<{ retryable: boolean; reason?: string; commitment: CommitmentState; statusCode?: number }> {
  if (error instanceof ProviderAdapterError) {
    const status = error.info?.statusCode;
    if (error.commitment !== "not-sent") {
      return { retryable: false, reason: "commitment-past-not-sent", commitment: error.commitment, ...(status === undefined ? {} : { statusCode: status }) };
    }
    if (status !== undefined && status >= 500) {
      return { retryable: false, reason: "provider-5xx-ambiguous", commitment: error.commitment, statusCode: status };
    }
    if (status === 429) return { retryable: true, reason: "rate-limit-budget", commitment: error.commitment, statusCode: status };
    if (status !== undefined && status >= 400 && status < 500) return { retryable: true, reason: "deterministic-rejection", commitment: error.commitment, statusCode: status };
    // Reaching here means the failure happened before any send: safe to retry.
    return { retryable: true, reason: "not-sent", commitment: error.commitment, ...(status === undefined ? {} : { statusCode: status }) };
  }
  return { retryable: false, reason: "non-provider-error", commitment: "unknown" };
}

/** Terminal reason for a canonical terminal event (secret-free). */
export function terminalReasonOf(event: CanonicalEvent): string {
  if (event.type === "response-completed") return "completed";
  if (event.type === "response-failed") return "provider-failed";
  if (event.type === "fidelity-artifacts") return "fidelity-artifacts";
  return event.type;
}

/** Guards the fixed key set for privacy tests. */
export function isAllowedRetryTraceKey(key: string): boolean {
  return ALLOWED_KEYS.has(key as keyof RetryTrace);
}
