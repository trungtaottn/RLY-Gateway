# ADR 0006: Persistent Per-User Runtime Service

- Status: Accepted
- Date: 2026-08-14
- Supersedes: the "background service management is a non-goal" line of [ADR 0003](./0003-transient-launcher-ownership.md)

## Context

The foreground, lease-owned lifecycle is correct for a launcher session but conflicts
with the approved product UX (#53): install once, run `rly init`, close the terminal, and
expect RLY infrastructure to remain available underneath Claude Code without an explicit
`rly gateway start` step. The runtime must become a per-user resident service while
preserving the deterministic loopback + attestation security model.

## Decision

- `rly init` bootstraps the per-user installation: it settles the durable `~/.rly` home
  (including the one-time legacy migration), validates the control-plane store, registers
  the per-user service idempotently, starts it, and waits for an attested compatible
  resident runtime.
- Per-user service registration uses macOS LaunchAgent (launchd) or Linux `systemd --user`
  behind one service-manager contract. Normal registration never requires root.
- The resident runtime **is** the existing attested loopback gateway + management listener
  started with explicit service ownership. There is no second daemon and no second data
  plane.
- Resident ownership is a service-owned lease renewed by the resident process itself.
  The existing zero-lease idle shutdown fires only when no lease is held, so an
  intentional resident service never enters idle shutdown. Launch/session leases for
  Claude/Codex children stay independent, tracked, and revocable.
- `rly <profile>`, `rly config`, diagnostics, and future update commands reuse the
  resident runtime through the existing attestation/lease machinery. When no service is
  initialized, the foreground launcher path remains the fallback (backward compatible).
- Explicit service stop is an authenticated in-process `/shutdown` request issued only
  after attestation: revoke launch sessions, bounded close, close broker/control-plane,
  clean owned runtime artifacts. A process is never signaled from port occupancy alone,
  and an unknown port owner is never killed.
- Crash recovery uses the service manager restart plus the existing startup-lock and
  process-identity rules; stale ownership records are recovered, foreign listeners fail
  closed.
- `/identity` carries advisory `runtimeVersion` and `resident` metadata so the CLI (and
  later #73 update logic) can distinguish a compatible resident runtime from an
  incompatible/stale one, and a foreign listener.

## Consequences

- Docs that deferred background service management (`docs/project-decisions.md`,
  `docs/BACKLOG.md`, `docs/ROADMAP.md`, `docs/SPEC.md` V1 non-goals) are updated in the
  same change so they no longer contradict the persistent-service decision.
- Platform specifics are implementation surfaces: #33 owns macOS launchd details and
  #34 owns Linux systemd details on top of the contract established here.
- Out of scope: system-wide/root daemon, remote administration or remote TLS bridge
  (#36), a second proxy implementation, and zero-downtime binary replacement (#73).

## Rejected alternatives

- Silently disabling lease safety globally: rejected; the resident service must still
  track and revoke child launch/session leases independently.
- A second daemon process: rejected; it would duplicate the attested ownership and
  fail-closed machinery.
