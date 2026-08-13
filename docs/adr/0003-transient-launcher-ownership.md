# ADR 0003: Transient Launcher And Process Ownership

- Status: Accepted
- Date: 2026-08-13

## Context

This machine already runs unrelated gateways. A launcher must support concurrent Claude Code sessions without mutating global configuration, choosing random ports, or killing foreign processes.

## Decision

- Default development endpoint is `127.0.0.1:17871`, subject to a read-only collision preflight.
- Launcher injects gateway URL and a transient gateway token only into the child harness environment.
- Gateway binds loopback only.
- An ownership record uses restrictive permissions and records PID, process start identity, instance UUID, port, executable/config fingerprint, launcher identity, nonce hash, and active leases.
- Reuse requires an identity challenge plus compatible ownership/config evidence.
- A foreign or mismatched listener causes an actionable failure. Never increment the port or signal the owner.
- Signals and cancellation propagate from harness to gateway/upstream.
- Foreground lifecycle is V1; background service management is a non-goal.

Protected existing ports are `10100`, `8317`, and `17870`. The project must not signal, stop, restart, reuse, or mutate their owners.

## Consequences

- Two compatible launchers may share one attested gateway through leases.
- Stale ownership and PID reuse require explicit tests.
- Health and readiness endpoints expose minimal, redacted information.
- Global Claude and Codex configuration hashes must remain unchanged in E2E and release gates.

## Rejected alternatives

- Port auto-increment: makes behavior nondeterministic.
- Kill-by-port cleanup: may terminate user or sibling processes.
- Persistent global client configuration: creates recovery and ownership risk.
