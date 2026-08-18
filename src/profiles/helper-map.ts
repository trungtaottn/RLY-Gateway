import { isProfileModelRole, type ProfileModelRole } from "./schema.js";

const HELPER_ROLES: Readonly<Record<string, ProfileModelRole>> = Object.freeze({
  "claude-haiku-4-5": "fast",
  "claude-sonnet-5": "primary",
  "claude-opus-4-8": "primary",
});

/** Maps a Claude helper/shortcut model onto a profile role. Unknown helpers stay unmapped. */
export function helperRoleFor(requestedModel: string): ProfileModelRole | undefined {
  return HELPER_ROLES[requestedModel.toLowerCase()];
}

export function resolveProfileRole(
  requestedModel: string,
  modelRoles: Readonly<Record<string, string>>,
): { role: ProfileModelRole; modelId: string } | undefined {
  if (isProfileModelRole(requestedModel)) {
    const modelId = modelRoles[requestedModel];
    if (modelId) return { role: requestedModel, modelId };
  }
  const exact = (Object.entries(modelRoles) as [ProfileModelRole, string][])
    .find(([, modelId]) => modelId === requestedModel);
  if (exact) return { role: exact[0], modelId: exact[1] };
  const helper = helperRoleFor(requestedModel);
  if (helper === undefined) return undefined;
  const mapped = modelRoles[helper];
  return mapped === undefined ? undefined : { role: helper, modelId: mapped };
}
