export class ProfileActivationError extends Error {
  override name = "ProfileActivationError";
  public constructor(
    readonly code: "profile-not-found" | "profile-not-claude" | "profile-has-no-pool" | "role-unmapped" | "capability-rejected" | "invalid-launch-policy",
    message = "Profile cannot be activated",
  ) {
    super(message);
  }
}
