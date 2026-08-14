import type { CapabilityRequirement, ProviderCapabilities } from "../../core/capabilities.js";
import type { PolicyRevision } from "../../control-plane/types.js";
import type { EffectiveRoute } from "../effective-route.js";
import type { CredentialSnapshot } from "../eligibility/reasons.js";
import type { DecisionTrace } from "../eligibility/trace.js";

export type SelectInput = Readonly<{
  requestId: string;
  poolId: string;
  policy: PolicyRevision;
  required: readonly CapabilityRequirement[];
  capabilities: ProviderCapabilities;
  modelId: string;
  adapterId: string;
  role: string;
  credentialSnapshots: ReadonlyMap<string, CredentialSnapshot>;
  sessionKey?: string;
  pinnedAccountId?: string;
  excludeAccountIds?: readonly string[];
}>;

export type SelectResult = Readonly<{
  route: EffectiveRoute;
  trace: DecisionTrace;
}>;
