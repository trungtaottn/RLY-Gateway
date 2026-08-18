import type { CanonicalEvent } from "../../core/canonical-event.js";
import type { RouteOutcomeClass } from "../../control-plane/health/types.js";
import { commitmentAllowsRetry, type CommitmentState } from "../../providers/commitment.js";

export function isOutputOrToolEvent(event: CanonicalEvent): boolean {
  return event.type === "text-delta"
    || event.type === "reasoning-delta"
    || event.type === "tool-arguments-delta"
    || (event.type === "content-started" && event.contentType === "tool-call");
}

/**
 * #121: rotation/retry is allowed ONLY when the policy can prove the previous
 * attempt never crossed a provider/client/tool commitment boundary:
 *
 * - `outputStarted` seals the route after client-visible output/tool events
 *   (legacy boundary, retained).
 * - `commitment` must be `not-sent`: the request never reached the provider,
 *   or the provider deterministically refused (4xx) before any acceptance.
 *   `unknown`, `sent-unacknowledged`, `provider-accepted`, and later states
 *   never rotate.
 */
export function canRotate(input: Readonly<{
  outputStarted: boolean;
  rotationsUsed: number;
  retryBudget: number;
  outcome: RouteOutcomeClass;
  commitment: CommitmentState;
}>): boolean {
  if (input.outputStarted) return false;
  if (input.rotationsUsed >= input.retryBudget) return false;
  if (!commitmentAllowsRetry(input.commitment)) return false;
  return input.outcome === "auth" || input.outcome === "quota" || input.outcome === "transient";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "client disconnected");
}
