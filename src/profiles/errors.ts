import type { ModelSelectionFailure } from "../routing/model-selection/errors.js";

export class ProfileActivationError extends Error {
  override name = "ProfileActivationError";
  public constructor(
    readonly code: "profile-not-found" | "profile-not-claude" | "profile-has-no-pool" | "role-unmapped" | "capability-rejected" | "invalid-launch-policy",
    message = "Profile cannot be activated",
    /**
     * Typed model-selection failure reason (#68) when the activation failed at
     * the model-selection stage. The HTTP contract keeps the stable
     * `capability-rejected` code; this carries the actionable taxonomy.
     */
    readonly modelFailure?: ModelSelectionFailure,
  ) {
    super(message);
  }
}
