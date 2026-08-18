/**
 * Typed failure taxonomy for provider/family-scoped tier resolution (#69).
 * Each code is actionable and maps deliberately onto the existing
 * profile/gateway error contract at the integration boundary (see
 * `src/profiles/resolve-route.ts` and `src/profiles/errors.ts`).
 */
export const TIER_RESOLUTION_FAILURES = [
  "unknown-tier",
  "family-unknown",
  "override-rejected",
  "mapping-invalid",
  "tier-unavailable",
] as const;

export type TierResolutionFailure = (typeof TIER_RESOLUTION_FAILURES)[number];

export class TierResolutionError extends Error {
  override name = "TierResolutionError";
  public constructor(
    readonly code: TierResolutionFailure,
    message?: string,
    /**
     * Underlying #68 model-selection failure code when the tier stage failed
     * at capability/compatibility validation, for diagnostics.
     */
    readonly causeCode?: string,
  ) {
    super(message ?? `Tier resolution failed: ${code}`);
  }
}

export function isTierResolutionError(error: unknown): error is TierResolutionError {
  return error instanceof TierResolutionError;
}
