# ADR 0004: Self-Owned Control Plane And Credentials

- Status: Accepted
- Date: 2026-08-13
- Supersedes: ADR 0002 credential-ownership restriction

## Context

The initial product delegated subscription OAuth and account state to external bridges. Local evidence from CCS, OpenCodeX, and claude-proxy showed that the intended product requires reusable provider accounts, credential lifecycle, profiles, pools, quota/health state, and configuration UI under one locally owned system.

## Decision

- Build a local control plane for providers, account metadata, profiles, pools, health, policy revisions, and metadata-only audit.
- Build a credential broker that owns explicit import, login, refresh, single-flight coordination, generation compare-and-swap, atomic persistence, backup, and recovery.
- Store OAuth secrets outside SQLite and Git in a project-owned `0700` directory with `0600` files or an approved OS secret backend.
- Import from another client store only through explicit user action and read-only by default. Provider-specific continuous interoperability requires schema pinning, locking, atomic writes, backups, and corruption recovery tests.
- Keep attested managed bridges as an alternative provider integration mode.
- Separate management and data API boundaries even when one local process hosts both.

## Consequences

- Provider, account, credential, profile, pool, and health become durable product concepts.
- Management authentication, Origin/CSRF protection, migrations, recovery, retention, and secret-free DTOs become release gates.
- Existing direct-provider and protocol/lifecycle code remains valid.
- ADR 0002 remains historical evidence for completed phases but no longer governs new provider integrations.

## Rejected alternatives

- Bridge-only ownership: cannot deliver the accepted account and pool experience.
- Raw OAuth secrets in SQLite or TOML: expands exposure and backup risk.
- Silent credential scraping: removes user intent and makes upstream schema drift unsafe.
- One adapter independently managing its own files: duplicates locking, recovery, and redaction logic.
