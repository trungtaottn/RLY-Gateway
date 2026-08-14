import type { CapabilityRequirement, ProviderCapabilities, ReasoningCapabilityEvidence } from "../../core/capabilities.js";
import type { ResolvedReasoning } from "../../core/reasoning.js";
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
  /** Exact selected-model reasoning evidence (#70). */
  reasoningEvidence?: ReasoningCapabilityEvidence;
  /** Deterministic intent→native translation result (#70). */
  resolvedReasoning?: ResolvedReasoning;
}>;

export type SelectResult = Readonly<{
  route: EffectiveRoute;
  trace: DecisionTrace;
}>;
