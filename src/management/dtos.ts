import { assertSecretFree } from "../control-plane/secret-free.js";
import type { AccountRecord, AuditEvent, PolicyRevision, PoolRecord, ProfileRecord, ProviderRecord } from "../control-plane/types.js";

export { assertSecretFree };

export function toProviderDto(record: ProviderRecord): Readonly<Record<string, unknown>> {
  return secretFree({
    id: record.id,
    name: record.name,
    integrationMode: record.integrationMode,
    endpointPolicy: record.endpointPolicy,
    capabilityEvidence: record.capabilityEvidence,
    requiredTermsRevision: record.requiredTermsRevision,
    provenanceRef: record.provenanceRef,
    enabled: record.enabled,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toAccountDto(
  record: AccountRecord,
  readiness?: "ready" | "unready" | "expired" | "paused" | "revoked",
): Readonly<Record<string, unknown>> {
  return secretFree({
    id: record.id,
    pseudonym: record.pseudonym,
    providerId: record.providerId,
    credentialHandle: record.credentialHandle,
    generation: record.credentialGeneration,
    state: record.state,
    readiness: readiness ?? (record.state === "ready" ? "unready" : record.state),
    pauseReason: record.pauseReason,
    quotaClass: record.quotaClass,
    cooldownUntil: record.cooldownUntil,
    termsRevision: record.termsRevision,
    termsAcknowledgedRevision: record.termsAcknowledgedRevision,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toPoolDto(record: PoolRecord): Readonly<Record<string, unknown>> {
  return secretFree({
    id: record.id,
    name: record.name,
    providerId: record.providerId,
    strategy: record.strategy,
    affinity: record.affinity,
    retryBudget: record.retryBudget,
    memberships: record.memberships,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toProfileDto(record: ProfileRecord): Readonly<Record<string, unknown>> {
  return secretFree({
    id: record.id,
    name: record.name,
    harness: record.harness,
    providerId: record.providerId,
    poolId: record.poolId,
    modelRoles: record.modelRoles,
    capabilityPolicy: record.capabilityPolicy,
    launchPolicy: record.launchPolicy,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toPolicyDto(record: PolicyRevision): Readonly<Record<string, unknown>> {
  return secretFree({
    revision: record.revision,
    hash: record.hash,
    createdAt: record.createdAt,
    providers: record.snapshot.providers.map(toProviderDto),
    accounts: record.snapshot.accounts.map((account) => toAccountDto(account)),
    pools: record.snapshot.pools.map(toPoolDto),
    profiles: record.snapshot.profiles.map(toProfileDto),
  });
}

export function toAuditDto(record: AuditEvent): Readonly<Record<string, unknown>> {
  return secretFree({
    id: record.id,
    action: record.action,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    actor: record.actor,
    result: record.result,
    metadata: record.metadata,
    createdAt: record.createdAt,
  });
}

function secretFree(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  assertSecretFree(value);
  return value;
}
