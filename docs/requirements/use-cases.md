# Use Cases

## UC-001 — Launch Claude with a profile

- Primary actor: Owner.
- Preconditions: profile valid; gateway absent or attested-compatible; at least one eligible route account.
- Main flow: owner runs `rly <profile>` (or `rly run claude --profile`) → runtime attests/start/reuses gateway → Claude receives transient settings → request-time selector binds account → interaction streams normally.
- Alternatives: no eligible account; foreign listener; unsupported capability; credential refresh required.
- Postcondition: global Claude configuration and foreign processes remain unchanged.

## UC-002 — Import a Codex account

- Primary actor: Owner.
- Preconditions: explicit import source and supported schema.
- Main flow: owner requests import → system previews non-secret metadata → owner confirms → broker copies credential to project store → account becomes manually selectable after readiness and terms checks.
- Alternatives: source changes during import; invalid schema; permission failure; duplicate credential generation.
- Postcondition: source store is unchanged.

## UC-003 — Authenticate a new provider account

- Primary actor: Owner.
- Main flow: select provider → start PKCE/state flow → browser authorization → exact callback validation → project credential persisted → readiness/terms status displayed.
- Alternatives: cancellation, state replay/expiry, callback collision, invalid grant, provider terms not accepted.

## UC-004 — Configure a pool

- Primary actor: Owner.
- Main flow: create pool → add owned accounts → select strategy/affinity/retry budget → validate → publish new policy revision.
- Alternatives: ineligible or cross-provider member; stale mutation version; invalid strategy.
- Postcondition: no account is preselected until a request arrives.

## UC-005 — Route a request through an account pool

- Primary actor: Claude Code or Codex CLI.
- Main flow: authenticate request → derive capabilities → load policy → filter eligible accounts → select deterministically → bind EffectiveRoute → invoke provider → stream response → record redacted outcome.
- Alternatives: safe pre-output rotation; no eligible candidate; post-output upstream failure without rotation.

## UC-006 — Pause or revoke an account

- Primary actor: Owner.
- Main flow: choose pseudonymous account → pause or revoke → versioned mutation commits → new requests exclude account → revoke removes all usable project records.
- Alternative: active request retains its immutable binding but no new request selects the account; upstream revoke unavailable still invalidates local use.

## UC-007 — Diagnose routing

- Primary actor: Owner.
- Main flow: open CLI/UI trace → view profile/provider/model/policy/pseudonym/readiness/decision/timing → take corrective action.
- Constraint: diagnostic surface contains no secret, identity, prompt, response, or tool argument.

## UC-008 — Recover after interruption

- Primary actor: Owner/system startup.
- Main flow: validate runtime ownership, database migration state, credential generations, temp/backups → recover last valid committed state → expose actionable degraded readiness when recovery cannot prove safety.

## UC-009 — Add a provider adapter

- Primary actor: Developer/owner.
- Main flow: freeze source/provenance → declare mode/capabilities/terms/credential behavior → add fixtures → implement behind shared contracts → run provider and live opt-in gates → publish readiness evidence.

## UC-010 — Publish the first public release

- Primary actor: Owner.
- Main flow: approve `dev` snapshot → run full release gates → create release branch from orphan `main` → copy snapshot → one public commit → one PR → review/merge.
- Constraint: private `dev` history and local artifacts never become ancestors or objects pushed for the public release.
