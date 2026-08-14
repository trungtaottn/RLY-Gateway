import { createHash } from "node:crypto";

export const SCHEMA_V2_VERSION = 2;

export const SCHEMA_V2_SQL = `
CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  pseudonym TEXT NOT NULL,
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
  updated_at TEXT NOT NULL,
  UNIQUE (provider_id, pseudonym)
) STRICT;
INSERT INTO accounts_new SELECT * FROM accounts;

CREATE TABLE memberships_tmp (
  pool_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  pin_order INTEGER,
  PRIMARY KEY (pool_id, account_id)
) STRICT;
INSERT INTO memberships_tmp SELECT * FROM memberships;
DROP TABLE memberships;

CREATE TABLE health_tmp (
  account_id TEXT NOT NULL,
  last_outcome TEXT,
  last_outcome_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  cooldown_until TEXT
) STRICT;
INSERT INTO health_tmp SELECT * FROM health;
DROP TABLE health;

CREATE TABLE terms_acknowledgements_tmp (
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  terms_revision TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (account_id, provider_id, terms_revision)
) STRICT;
INSERT INTO terms_acknowledgements_tmp SELECT * FROM terms_acknowledgements;
DROP TABLE terms_acknowledgements;

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

CREATE TABLE memberships (
  pool_id TEXT NOT NULL REFERENCES pools(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  pin_order INTEGER,
  PRIMARY KEY (pool_id, account_id)
) STRICT;
INSERT INTO memberships SELECT * FROM memberships_tmp;
DROP TABLE memberships_tmp;

CREATE TABLE health (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  last_outcome TEXT,
  last_outcome_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  cooldown_until TEXT
) STRICT;
INSERT INTO health SELECT * FROM health_tmp;
DROP TABLE health_tmp;

CREATE TABLE terms_acknowledgements (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider_id TEXT NOT NULL REFERENCES providers(id),
  terms_revision TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (account_id, provider_id, terms_revision)
) STRICT;
INSERT INTO terms_acknowledgements SELECT * FROM terms_acknowledgements_tmp;
DROP TABLE terms_acknowledgements_tmp;
`;

export const SCHEMA_V2_CHECKSUM = createHash("sha256").update(SCHEMA_V2_SQL).digest("hex");
