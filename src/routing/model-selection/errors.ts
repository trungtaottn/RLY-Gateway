/**
 * Typed failure taxonomy for model selection (#68). Each code is actionable
 * and maps deliberately onto the existing profile/gateway error contract at
 * the integration boundary (see `src/profiles/resolve-route.ts`).
 */
export const MODEL_SELECTION_FAILURES = [
  "unknown-exact-model",
  "no-trusted-evidence",
  "capability-unsupported",
  "reasoning-unsupported",
  "reasoning-translation-unsupported",
  "reasoning-budget-policy-missing",
  "compatibility-rejected",
  "no-eligible-candidate",
] as const;

export type ModelSelectionFailure = (typeof MODEL_SELECTION_FAILURES)[number];

export class ModelSelectionError extends Error {
  override name = "ModelSelectionError";
  public constructor(
    readonly code: ModelSelectionFailure,
    message?: string,
  ) {
    super(message ?? `Model selection failed: ${code}`);
  }
}

export function isModelSelectionError(error: unknown): error is ModelSelectionError {
  return error instanceof ModelSelectionError;
}
