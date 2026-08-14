import type { ControlPlaneStore } from "../../control-plane/store.js";
import type { AccountRecord, PolicyRevision, PoolRecord, ProviderRecord } from "../../control-plane/types.js";
import { ValidationError } from "../../control-plane/errors.js";
import { createEffectiveRoute, type EffectiveRoute } from "../effective-route.js";
import { evaluateEligibility } from "../eligibility/evaluate.js";
import type { CandidateAssessment } from "../eligibility/reasons.js";
import type { SelectInput } from "./types.js";

export function requirePool(policy: PolicyRevision, poolId: string): PoolRecord {
  const pool = policy.snapshot.pools.find((item) => item.id === poolId);
  if (pool === undefined) throw new ValidationError("pool was not found");
  return pool;
}

export function sourceRuleFor(strategy: PoolRecord["strategy"], affinity: boolean): string {
  if (affinity) return `pool:${strategy}:affinity`;
  if (strategy === "manual") return "pool:manual:pin";
  return `pool:${strategy}`;
}

export function assessPool(store: ControlPlaneStore, pool: PoolRecord, input: SelectInput, now: Date): CandidateAssessment[] {
  return pool.memberships.map((membership) => {
    const account = liveAccount(store, membership.accountId, input.policy);
    if (account === undefined) {
      return {
        accountId: membership.accountId,
        accountPseudonym: "acct-unknown",
        credentialHandle: "",
        credentialGeneration: 0,
        pinOrder: membership.pinOrder ?? Number.MAX_SAFE_INTEGER,
        quotaClass: "unknown",
        eligible: false,
        reasons: ["auth-unready" as const],
      };
    }
    return evaluateAccount(store, account, input, now, membership.pinOrder);
  });
}

export function assessAccount(
  store: ControlPlaneStore,
  accountId: string,
  pool: PoolRecord,
  input: Omit<SelectInput, "requestId" | "modelId" | "adapterId" | "role">,
  now: Date,
): CandidateAssessment | undefined {
  const membership = pool.memberships.find((item) => item.accountId === accountId);
  const account = liveAccount(store, accountId, input.policy);
  if (account === undefined) return undefined;
  return evaluateAccount(store, account, input, now, membership?.pinOrder);
}

export function bindRoute(
  input: SelectInput,
  pool: PoolRecord,
  selected: CandidateAssessment,
  sourceRule: string,
  decidedAt: string,
): EffectiveRoute {
  return createEffectiveRoute({
    requestId: input.requestId,
    providerId: pool.providerId,
    modelId: input.modelId,
    adapterId: input.adapterId,
    accountId: selected.accountId,
    accountPseudonym: selected.accountPseudonym,
    credentialHandle: selected.credentialHandle,
    credentialGeneration: selected.credentialGeneration,
    sourceRule,
    policyRevision: input.policy.revision,
    policyHash: input.policy.hash,
    capabilitySnapshot: input.capabilities,
    decidedAt,
    outputStarted: false,
  });
}

function evaluateAccount(
  store: ControlPlaneStore,
  account: AccountRecord,
  input: Omit<SelectInput, "requestId" | "modelId" | "adapterId" | "role">,
  now: Date,
  pinOrder: number | undefined,
): CandidateAssessment {
  return evaluateEligibility({
    account,
    provider: liveProvider(store, account.providerId, input.policy),
    pinOrder: pinOrder ?? Number.MAX_SAFE_INTEGER,
    now,
    credential: input.credentialSnapshots.get(account.credentialHandle),
    required: input.required,
    capabilities: input.capabilities,
    health: store.getHealth(account.id),
  });
}

function liveAccount(store: ControlPlaneStore, accountId: string, policy: PolicyRevision): AccountRecord | undefined {
  return store.listAccounts().find((account) => account.id === accountId)
    ?? policy.snapshot.accounts.find((account) => account.id === accountId);
}

function liveProvider(store: ControlPlaneStore, providerId: string, policy: PolicyRevision): ProviderRecord | undefined {
  return store.listProviders().find((provider) => provider.id === providerId)
    ?? policy.snapshot.providers.find((provider) => provider.id === providerId);
}
