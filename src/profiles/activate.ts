import { ZodError } from "zod";
import type { CapabilityRequirement, ProviderCapabilities } from "../core/capabilities.js";
import type { ProfileRecord } from "../control-plane/types.js";
import { ProfileActivationError } from "./errors.js";
import { resolveProfileRole } from "./helper-map.js";
import {
  applyCapabilityPolicy,
  missingProfileCapabilities,
  parseCapabilityPolicy,
  parseLaunchPolicy,
  type LaunchPolicy,
} from "./schema.js";

export type ActivatedProfile = Readonly<{
  profile: ProfileRecord;
  poolId: string;
  role: "primary" | "fast" | "reasoning";
  modelId: string;
  capabilities: ProviderCapabilities;
  launchPolicy: LaunchPolicy;
}>;

export function findProfileByName(profiles: readonly ProfileRecord[], name: string): ProfileRecord | undefined {
  return profiles.find((item) => item.name === name);
}

export function findProfileById(profiles: readonly ProfileRecord[], id: string): ProfileRecord | undefined {
  return profiles.find((item) => item.id === id);
}

/** Validates a named profile for launch. Never binds an account. */
export function inspectLaunchableProfile(
  profiles: readonly ProfileRecord[],
  name: string,
  requireClaude = true,
): { profile: ProfileRecord; launchPolicy: LaunchPolicy; poolId: string } {
  const profile = findProfileByName(profiles, name);
  if (!profile) throw new ProfileActivationError("profile-not-found");
  if (requireClaude && profile.harness !== "claude") {
    throw new ProfileActivationError("profile-not-claude");
  }
  if (profile.poolId === undefined) throw new ProfileActivationError("profile-has-no-pool");
  try {
    return { profile, launchPolicy: parseLaunchPolicy(profile.launchPolicy), poolId: profile.poolId };
  } catch (error) {
    if (error instanceof ZodError) throw new ProfileActivationError("invalid-launch-policy");
    throw error;
  }
}

/** Resolves a named profile to policy only. Never binds an account. */
export function activateProfile(
  profiles: readonly ProfileRecord[],
  input: Readonly<{
    name?: string;
    profileId?: string;
    requestedModel: string;
    required: readonly CapabilityRequirement[];
    baseCapabilities: ProviderCapabilities;
    requireClaude?: boolean;
  }>,
): ActivatedProfile {
  const named = input.profileId === undefined
    ? undefined
    : findProfileById(profiles, input.profileId)?.name;
  const { profile, launchPolicy, poolId } = inspectLaunchableProfile(
    profiles,
    named ?? input.name ?? "",
    input.requireClaude !== false,
  );
  if (input.profileId !== undefined && profile.id !== input.profileId) {
    throw new ProfileActivationError("profile-not-found");
  }
  const mapped = resolveProfileRole(input.requestedModel, profile.modelRoles);
  if (!mapped) throw new ProfileActivationError("role-unmapped");
  let capabilities: ProviderCapabilities;
  try {
    capabilities = applyCapabilityPolicy(input.baseCapabilities, parseCapabilityPolicy(profile.capabilityPolicy));
  } catch (error) {
    if (error instanceof ZodError) throw new ProfileActivationError("invalid-launch-policy");
    throw error;
  }
  if (missingProfileCapabilities(capabilities, input.required).length > 0) {
    throw new ProfileActivationError("capability-rejected");
  }
  return {
    profile,
    poolId,
    role: mapped.role,
    modelId: mapped.modelId,
    capabilities,
    launchPolicy,
  };
}
