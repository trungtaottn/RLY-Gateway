import type { CanonicalEvent } from "../../core/canonical-event.js";
import type { RouteOutcomeClass } from "../../control-plane/health/types.js";

export function isOutputOrToolEvent(event: CanonicalEvent): boolean {
  return event.type === "text-delta"
    || event.type === "reasoning-delta"
    || event.type === "tool-arguments-delta"
    || (event.type === "content-started" && event.contentType === "tool-call");
}

export function canRotate(input: Readonly<{
  outputStarted: boolean;
  rotationsUsed: number;
  retryBudget: number;
  outcome: RouteOutcomeClass;
}>): boolean {
  if (input.outputStarted) return false;
  if (input.rotationsUsed >= input.retryBudget) return false;
  return input.outcome === "auth" || input.outcome === "quota" || input.outcome === "transient";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "client disconnected");
}
