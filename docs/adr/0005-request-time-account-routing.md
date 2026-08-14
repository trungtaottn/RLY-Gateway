# ADR 0005: Request-Time Account Routing

- Status: Accepted
- Date: 2026-08-13

## Context

Account eligibility changes with authentication, expiry, quota, pause, cooldown, and credential generation. Publishing a fixed account choice before a request would make routing stale and unsafe. Rotation after streaming begins can duplicate text or tool effects.

## Decision

- Control plane publishes an immutable policy/configuration revision, not a preselected account.
- For each request, the data plane derives required capabilities, loads one policy revision, filters eligible accounts, applies the configured strategy, binds one account pseudonym and credential generation, then creates an immutable `EffectiveRoute`.
- Initial strategies are manual pin, `round-robin`, and `fill-first`. Quota-aware selection requires evidence-backed quota state.
- Paused, expired, authentication-unready, cooling, capability-incompatible, and terms-unaccepted accounts are never eligible. Quota-exhausted accounts are ineligible only while cooling; after cooldown they are recovery probes. Success restores healthy.
- Retry or account rotation is bounded and allowed only before the first response byte or tool event.
- Outcomes update health, quota, cooldown, and audit transactionally without recording prompts, responses, secrets, or account identity.

## Consequences

- Selection logic is deterministic and testable independently from providers.
- Every request can explain its decision through a secret-free trace.
- Credential refresh generation and pool state require concurrency and crash-recovery coverage.
- Existing immutable route and capability-preflight contracts are retained.

## Rejected alternatives

- Select account when a profile is activated: eligibility may drift before the request.
- Silent mid-stream failover: may duplicate irreversible tool effects.
- Adapter-specific pools: fragments policy and makes cross-provider behavior inconsistent.
