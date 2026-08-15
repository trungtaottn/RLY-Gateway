/**
 * Typed failure taxonomy for model-intent classification (#125).
 *
 * These codes distinguish selector-namespace/classification failures from the
 * downstream #68 exact-selection and #69 tier-resolution failures. Each code
 * maps deliberately onto the existing profile/gateway error contract at the
 * integration boundary (see `src/profiles/resolve-route.ts` and
 * `src/profiles/errors.ts`).
 */
export const MODEL_INTENT_FAILURES = [
  "unknown-namespace",
  "unsupported-client-alias",
  "invalid-projection",
  "conflicting-selector-sources",
] as const;

export type ModelIntentFailure = (typeof MODEL_INTENT_FAILURES)[number];

export class ModelIntentError extends Error {
  override name = "ModelIntentError";
  public constructor(
    readonly code: ModelIntentFailure,
    message?: string,
  ) {
    super(message ?? `Model intent classification failed: ${code}`);
  }
}

export function isModelIntentError(error: unknown): error is ModelIntentError {
  return error instanceof ModelIntentError;
}
