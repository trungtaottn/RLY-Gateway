# Functional Requirements Specification

## Functional domains

### FR-001 — Initialize and attest local runtime

- Traces: BR-008, SR-F-018, SR-NF-001.
- Preconditions: configured deterministic ports are available or owned by a compatible attested instance.
- Behavior: inspect listeners and ownership; start one loopback instance or acquire a compatible lease; create separate data and management secrets; launch the requested harness with transient settings.
- Failure: foreign/mismatched listener returns an actionable error; no signal, reuse, or alternate port.
- Acceptance: AT-001, AT-002.

### FR-002 — Administer provider definitions

- Traces: BR-002, BR-010, SR-F-004.
- Preconditions: authenticated management principal.
- Behavior: create/update/disable provider definition, integration mode, endpoint policy, capability evidence, required terms revision, and provenance reference using optimistic versioning.
- Failure: stale version, invalid mode, missing evidence, or unauthorized mutation fails without partial state.
- Acceptance: AT-003, AT-004.

### FR-003 — Import an existing credential

- Traces: BR-003, SR-F-006, SR-NF-002/003.
- Preconditions: explicit source path/type, provider importer, and owner confirmation.
- Main flow: read bounded source; validate schema; derive non-secret account metadata; write a new project record atomically; preserve source hashes/metadata for immutability proof; return a handle only.
- Failure: schema drift, permission failure, collision, secret validation failure, or source change aborts import and removes temporary project files.
- Acceptance: AT-005, AT-006.

### FR-004 — Complete OAuth login

- Traces: BR-003, SR-F-007, SR-NF-005.
- Preconditions: provider OAuth adapter and free exact loopback callback endpoint.
- Main flow: generate PKCE and single-use expiring state; open authorization; validate exact callback/state; exchange bounded response; atomically persist generation one; expose readiness without identity or token.
- Failure: state mismatch/replay/expiry, callback collision, cancellation, invalid grant, malformed response, or oversized error leaves no usable partial credential.
- Acceptance: AT-007, AT-008.

### FR-005 — Refresh a credential safely

- Traces: BR-003, SR-F-007/008, SR-NF-006.
- Preconditions: refreshable current generation and refresh requirement.
- Behavior: acquire per-credential single-flight and an ownership-aware lock (lock id, credential handle, owner pid, process start identity, timestamp); never steal a live lock; reclaim a lock only when pid/start identity proves the owner is gone; refresh; validate response; commit only if stored generation still matches; atomically replace and retire transient backup.
- Failure: stale refresh cannot overwrite a newer generation; invalid grant marks account authentication-unready without exposing upstream body.
- Acceptance: AT-009, AT-010.

### FR-006 — Logout, revoke, and recover credentials

- Traces: BR-003, BR-012, SR-F-007/008.
- Behavior: invoke upstream revoke where supported; invalidate local account; remove active/temp/backup usable records; fsync directory; recover only the last schema-valid, non-revoked record after interrupted writes.
- Constraint: do not claim forensic erasure of deleted filesystem blocks.
- Acceptance: AT-011, AT-012.

### FR-007 — Manage accounts and terms

- Traces: BR-002, BR-010, SR-F-005/010.
- Behavior: list pseudonymous accounts keyed by `(provider, pseudonym)` so the same pseudonym may exist on another provider; show readiness/quota class/pause/cooldown/terms state; pause/resume; acknowledge a specific provider terms revision; invalidate acceptance when required revision changes.
- Failure: credential/provider mismatch fails closed; UI/CLI never returns raw identity or secret.
- Acceptance: AT-013, AT-014.

### FR-008 — Configure pools and profiles

- Traces: BR-001/002/007, SR-F-009/011/015.
- Behavior: create pool membership, strategy, bounded affinity/retry; create harness profile with provider/pool and model roles; validate referenced capabilities and ownership. The profile name is the canonical Claude Code alias: `rly <profile>` launches Claude Code with that profile; `rly run claude --profile <name>` remains compatibility; `rly run codex` launches Codex CLI and is not a profile alias. Reserved CLI commands are never treated as profile names.
- Failure: invalid references, duplicate memberships, unsupported strategy, or stale version fails atomically. Unknown profile names fail closed and are not remapped to Codex CLI.
- Acceptance: AT-015, AT-016, AT-033.

### FR-009 — Select an account per request

- Traces: BR-005/010, SR-F-010/012/013.
- Main flow: decode request; derive capabilities; load one policy revision; refresh the selected credential to a final generation; filter eligibility including terms; apply deterministic strategy; bind account pseudonym and that credential generation; create immutable EffectiveRoute; invoke using the frozen generation without a further refresh.
- Failure: no eligible account returns a structured, secret-free error; no silent provider/model substitution.
- Acceptance: AT-017, AT-018.

### FR-010 — Handle provider outcome and bounded rotation

- Traces: BR-005/012, SR-F-013/014.
- Behavior: classify pre-output authentication/quota/transient failures; transactionally update health/cooldown; rotate only within configured budget and only before first output/tool event; seal route after output begins. Quota failure marks `exhausted` and starts cooldown; after cooldown the account is a recovery probe; success restores `healthy`; probe failure extends cooldown. Authentication, quota, and transient stay classified separately; invalid-grant may mark authentication-unready without treating that as quota death.
- Failure: post-output failure propagates without another account invocation.
- Acceptance: AT-019, AT-020.

### FR-011 — Preserve Claude Code protocol behavior

- Traces: BR-001/006, SR-F-001/003/015.
- Behavior: preserve text, image, tool, thinking, usage, stop, stream, cancellation, helper-role mapping, and concurrency within declared capability.
- Failure: unsupported required behavior rejects before upstream invocation.
- Acceptance: AT-021, AT-022.

### FR-012 — Preserve Codex Responses behavior

- Traces: BR-006, SR-F-002/003/015.
- Behavior: preserve Responses item/event, function argument, reasoning, usage, error, cancellation, and continuation semantics through the shared control plane.
- Failure: unknown required lifecycle semantics mark compatibility unready.
- Acceptance: AT-023, AT-024.

### FR-013 — Operate management CLI and UI

- Traces: BR-002/007/009, SR-F-016/017.
- Behavior: CLI authenticates with separate instance bearer; browser exchanges a single-use fragment for a bounded session; all mutations require exact Origin, CSRF, current version, and secret-free DTOs; logout/shutdown invalidates session.
- Accessibility behavior: UI supports keyboard-only operation, visible focus, programmatic labels, textual status/error output, and supported responsive viewports.
- Acceptance: AT-025, AT-026, AT-031.

### FR-014 — Diagnose without leaking data

- Traces: BR-005/009, SR-F-014/016, SR-NF-009.
- Behavior: expose request ID, provider/model/profile, policy revision, pseudonymous account, capability/readiness, decision reason, timing/status, and coarse quota class.
- Prohibition: no prompt, response, tool argument, email, account identity, authorization header, or raw credential.
- Acceptance: AT-027.

### FR-015 — Reuse upstream source with provenance

- Traces: BR-004, SR-F-019.
- Behavior: require exact revision/artifact hash, source/destination paths, license, copyright notice, adaptation classification, and verification owner before substantial copy.
- Failure: unknown CLIProxy Plus or other component license blocks copying that component.
- Acceptance: AT-028.

### FR-016 — Bootstrap a clean public baseline and promote releases

- Traces: BR-011, SR-F-020.
- Preconditions: approved `dev` snapshot passes release/privacy/provenance gates.
- Behavior: for the one-time baseline, create a release branch from orphan `main`; copy the approved tracked snapshot without `.git` history/local artifacts; create one commit; open one PR to `main`. After that baseline, promote `dev` to `main` only through a reviewed PR that preserves ancestry.
- Prohibition: never merge/rebase historical private `dev` into `main` or push private branches as part of the first public baseline.
- Acceptance: AT-029, AT-030.

### FR-017 — Enforce retention and deletion

- Traces: BR-009/012, SR-F-021, SR-NF-008/009/014.
- Behavior: apply a versioned policy to logs, metadata audit, response continuation state, temporary/backup credentials, revoked records, database/migration backups, and cleanup evidence; refuse release when a class lacks an owner, duration/budget, or deletion verification.
- Failure: interrupted cleanup remains recoverable and resumes idempotently; expired material cannot re-enter active state.
- Constraint: deletion evidence proves application-level reachability/removal, not forensic media erasure.
- Acceptance: AT-032.

### FR-018 — Bootstrap and operate the persistent per-user runtime service

- Traces: BR-008, SR-F-022, SR-NF-001/002.
- Preconditions: `rly init` is invoked with a valid configuration; deterministic ports are available or owned by a compatible attested resident instance.
- Behavior: settle the durable `~/.rly` home; validate the control-plane store; register the per-user service idempotently (macOS LaunchAgent or Linux `systemd --user`, no root); start the resident runtime; wait for an attested compatible resident instance; expose `rly gateway start|stop|status`; report version/resident state.
- Resident ownership: the service holds a service-owned lease renewed by its own process, so the zero-lease idle shutdown never fires while the service is intentional; child launch/session leases stay independent and revocable.
- Failure: foreign or unattested listener fails closed without signaling the owner; a launcher-owned instance is never reused or killed by the service; stale records are recovered with startup-lock/process-identity rules.
- Shutdown: explicit service stop revokes launch sessions and closes boundedly (revoke, bounded close, broker/control-plane close, artifact cleanup).
- Prohibition: no credential, token, or account identity in service definitions, logs, or diagnostics.
- Acceptance: AT-034.

## Unresolved questions

- Exact quota-aware strategy behavior after live quota evidence is pinned.
