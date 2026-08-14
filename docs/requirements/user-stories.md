# User Stories

## Product owner and operator

### US-001 — Use one profile across providers

As the owner, I want to launch Claude Code with a named profile (`rly <profile>`) so that provider, pool, model roles, and safety policy are repeatable without changing global Claude configuration.

Acceptance: profile validation succeeds; request-time account selection remains dynamic; AT-001, AT-015, AT-021, AT-033.

### US-002 — Import an existing account safely

As the owner, I want to explicitly import a supported Codex credential so that I can reuse my subscription while the source client store remains unchanged.

Acceptance: preview contains non-secret metadata only; project record is atomic and restrictive; source hash is unchanged; AT-005, AT-006.

### US-003 — Authenticate and refresh an account

As the owner, I want the product to complete OAuth and refresh credentials safely so that long-running use does not depend on manual token copying.

Acceptance: PKCE/state/callback tests pass; concurrent refresh commits one generation; AT-007–AT-010.

### US-004 — Control account eligibility

As the owner, I want to pause, resume, pin, revoke, and acknowledge terms for accounts so that only explicitly accepted and healthy accounts can serve requests.

Acceptance: paused/revoked/terms-unaccepted accounts are never selected; AT-011–AT-014.

### US-005 — Configure deterministic pools

As the owner, I want manual, round-robin, fill-first, and bounded-affinity policies so that account use is predictable and explainable.

Acceptance: identical eligible state produces deterministic decisions; AT-015–AT-020.

### US-006 — Diagnose without exposing secrets

As the owner, I want status, health, quota class, and route reasons through CLI/UI so that I can repair configuration without opening credential files or leaking identity.

Acceptance: diagnostic privacy checks pass; AT-025–AT-027.

## Harness user

### US-007 — Preserve Claude Code behavior

As a Claude Code user, I want tools, reasoning, streaming, helpers, cancellation, and concurrency to work through selected providers so that changing the backend does not break my workflow.

Acceptance: supported Claude contract and E2E scenarios pass; AT-021, AT-022.

### US-008 — Preserve Codex CLI behavior

As a Codex CLI user, I want Responses items, function arguments, reasoning, usage, cancellation, and continuation preserved so that the shared control plane does not flatten Codex semantics.

Acceptance: Responses contract and Codex E2E pass; AT-023, AT-024.

## Developer and reviewer

### US-009 — Add a provider through stable contracts

As a developer, I want provider mode, credentials, capabilities, terms, fixtures, and provenance defined before implementation so that an adapter cannot bypass shared safety rules.

Acceptance: provider management and provenance gates pass; AT-003, AT-004, AT-028.

### US-010 — Recover state after failure

As an operator, I want database, credential, process, and migration recovery to restore the last valid state so that local failures do not corrupt account access or routing decisions.

Acceptance: corruption, crash, restart, and rollback scenarios pass; AT-002, AT-010, AT-012.

### US-011 — Verify requirements end to end

As QA/security, I want stable IDs and traceability from business need to acceptance evidence so that phase completion cannot be declared from narrative alone.

Acceptance: every Must BR has downstream system, functional, and acceptance coverage; AT-030.

### US-012 — Publish without private history

As the owner, I want one reviewed public snapshot PR so that `main` exposes a clean product baseline without the private development history or local artifacts from `dev`.

Acceptance: orphan topology, one snapshot commit, exclusion, and release gates pass; AT-029, AT-030.

## Definition of ready

A story is ready when its upstream BR/SR/FR IDs exist, business decisions are resolved, provider terms risk is explicit, acceptance scenarios are named, and dependencies are available.

## Definition of done

A story is done only when implementation and focused tests pass, RTM evidence is updated, affected authority/ADRs are reconciled, privacy/provenance impact is closed, and the active plan/TASKLIST reflects verified—not assumed—status.
