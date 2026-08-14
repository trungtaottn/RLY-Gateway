import { ValidationError } from "./errors.js";
import { assertSecretFree } from "./secret-free.js";
import type { HealthRecord } from "./health/types.js";
import type {
  AccountRecord,
  AccountState,
  AuditEvent,
  AuditResult,
  HarnessName,
  IntegrationMode,
  ManagementActor,
  MembershipRecord,
  PoolRecord,
  PoolStrategy,
  ProfileRecord,
  ProviderRecord,
} from "./types.js";

export type SqlRow = Readonly<Record<string, string | number | bigint | null>>;

function text(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new ValidationError(`invalid ${key}`);
  return value;
}

function optionalText(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidationError(`invalid ${key}`);
  return value;
}

function integer(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new ValidationError(`invalid ${key}`);
  return value;
}

function optionalInteger(row: SqlRow, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new ValidationError(`invalid ${key}`);
  return value;
}

function jsonValue(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ValidationError("stored JSON is corrupt");
  }
}

export function parseJsonObject(raw: string): Readonly<Record<string, string>> {
  const value = jsonValue(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("expected a JSON object");
  }
  const output: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child !== "string" || child.length === 0) throw new ValidationError("JSON object values must be strings");
    output[key] = child;
  }
  return output;
}

export function encodeJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    assertSecretFree(value);
  } catch {
    throw new ValidationError("JSON fields must not contain secret or identity keys");
  }
  return JSON.stringify(value);
}

export function mapProvider(row: SqlRow): ProviderRecord {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    integrationMode: text(row, "integration_mode") as IntegrationMode,
    endpointPolicy: optionalText(row, "endpoint_policy"),
    capabilityEvidence: jsonValue(optionalText(row, "capability_evidence")),
    requiredTermsRevision: optionalText(row, "required_terms_revision"),
    provenanceRef: optionalText(row, "provenance_ref"),
    enabled: integer(row, "enabled") === 1,
    version: integer(row, "version"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

export function mapAccount(row: SqlRow): AccountRecord {
  return {
    id: text(row, "id"),
    pseudonym: text(row, "pseudonym"),
    providerId: text(row, "provider_id"),
    credentialHandle: text(row, "credential_handle"),
    credentialGeneration: integer(row, "credential_generation"),
    state: text(row, "state") as AccountState,
    pauseReason: optionalText(row, "pause_reason"),
    quotaClass: text(row, "quota_class"),
    cooldownUntil: optionalText(row, "cooldown_until"),
    termsRevision: optionalText(row, "terms_revision"),
    termsAcknowledgedRevision: optionalText(row, "terms_acknowledged_revision"),
    version: integer(row, "version"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

export function mapHealth(row: SqlRow): HealthRecord {
  return {
    accountId: text(row, "account_id"),
    lastOutcome: optionalText(row, "last_outcome"),
    lastOutcomeAt: optionalText(row, "last_outcome_at"),
    consecutiveFailures: integer(row, "consecutive_failures"),
    cooldownUntil: optionalText(row, "cooldown_until"),
  };
}

export function mapMembership(row: SqlRow): MembershipRecord {
  return {
    poolId: text(row, "pool_id"),
    accountId: text(row, "account_id"),
    pinOrder: optionalInteger(row, "pin_order"),
  };
}

export function mapPool(row: SqlRow, memberships: readonly MembershipRecord[]): PoolRecord {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    providerId: text(row, "provider_id"),
    strategy: text(row, "strategy") as PoolStrategy,
    affinity: jsonValue(optionalText(row, "affinity")),
    retryBudget: integer(row, "retry_budget"),
    memberships,
    version: integer(row, "version"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

export function mapProfile(row: SqlRow): ProfileRecord {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    harness: text(row, "harness") as HarnessName,
    providerId: optionalText(row, "provider_id"),
    poolId: optionalText(row, "pool_id"),
    modelRoles: parseJsonObject(text(row, "model_roles")),
    capabilityPolicy: jsonValue(optionalText(row, "capability_policy")),
    launchPolicy: jsonValue(optionalText(row, "launch_policy")),
    version: integer(row, "version"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

export function mapAudit(row: SqlRow): AuditEvent {
  const metadata = jsonValue(text(row, "metadata_json"));
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new ValidationError("audit metadata must be an object");
  }
  return {
    id: text(row, "id"),
    action: text(row, "action"),
    resourceType: text(row, "resource_type"),
    resourceId: optionalText(row, "resource_id"),
    actor: text(row, "actor") as ManagementActor,
    result: text(row, "result") as AuditResult,
    metadata: metadata as Readonly<Record<string, unknown>>,
    createdAt: text(row, "created_at"),
  };
}
