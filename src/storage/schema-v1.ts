import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;

export const FORBIDDEN_COLUMN_NAMES = [
  "access_token",
  "refresh_token",
  "authorization",
  "token",
  "secret",
  "password",
  "email",
  "prompt",
  "response",
  "identity",
] as const;

export const SCHEMA_V1_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
) STRICT;

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  integration_mode TEXT NOT NULL CHECK (integration_mode IN ('direct', 'oauth', 'bridge')),
  endpoint_policy TEXT,
  capability_evidence TEXT,
  required_terms_revision TEXT,
  provenance_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  pseudonym TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  credential_handle TEXT NOT NULL,
  credential_generation INTEGER NOT NULL DEFAULT 0 CHECK (credential_generation >= 0),
  state TEXT NOT NULL CHECK (state IN ('ready', 'paused', 'unready', 'revoked')),
  pause_reason TEXT,
  quota_class TEXT NOT NULL DEFAULT 'unknown',
  cooldown_until TEXT,
  terms_revision TEXT,
  terms_acknowledged_revision TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  strategy TEXT NOT NULL CHECK (strategy IN ('manual', 'round-robin', 'fill-first')),
  affinity TEXT,
  retry_budget INTEGER NOT NULL DEFAULT 1 CHECK (retry_budget >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE memberships (
  pool_id TEXT NOT NULL REFERENCES pools(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  pin_order INTEGER,
  PRIMARY KEY (pool_id, account_id)
) STRICT;

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  harness TEXT NOT NULL CHECK (harness IN ('claude', 'codex')),
  provider_id TEXT REFERENCES providers(id),
  pool_id TEXT REFERENCES pools(id),
  model_roles TEXT NOT NULL,
  capability_policy TEXT,
  launch_policy TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (provider_id IS NOT NULL OR pool_id IS NOT NULL)
) STRICT;

CREATE TABLE health (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  last_outcome TEXT,
  last_outcome_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  cooldown_until TEXT
) STRICT;

CREATE TABLE terms_acknowledgements (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider_id TEXT NOT NULL REFERENCES providers(id),
  terms_revision TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (account_id, provider_id, terms_revision)
) STRICT;

CREATE TABLE policy_revisions (
  revision INTEGER PRIMARY KEY,
  compiled_json TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  actor TEXT NOT NULL CHECK (actor IN ('cli', 'browser', 'system')),
  result TEXT NOT NULL CHECK (result IN ('ok', 'rejected')),
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
`;

export const SCHEMA_V1_CHECKSUM = createHash("sha256").update(SCHEMA_V1_SQL).digest("hex");

export function assertSchemaHasNoSecretColumns(sql: string): void {
  const columns = [...sql.matchAll(/\n\s{2}([a-z_]+)\s/g)].map((match) => match[1]);
  for (const column of columns) {
    if (column !== undefined && (FORBIDDEN_COLUMN_NAMES as readonly string[]).includes(column)) {
      throw new Error("Control-plane schema must not declare secret or identity columns");
    }
  }
}
