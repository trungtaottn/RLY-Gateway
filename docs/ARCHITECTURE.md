# RLY Gateway Architecture

## System intent

RLY Gateway is a local subscription orchestration fabric. Claude Code is the single coding harness; a profile name is the user-facing alias. The gateway preserves Anthropic Messages (and OpenAI Responses for the `rly run codex` escape hatch) while a self-owned local control plane manages providers, credentials, accounts, profiles, pools, health, and routing policy.

## Target layers

```text
Control plane
  ├─ provider/account/profile/pool configuration
  ├─ credential broker and project-owned secret records
  ├─ quota/health/cooldown and policy revision
  └─ authenticated management API and metadata-only audit
       ↓ versioned policy
Target launcher → Claude Code (`rly <profile>` or `rly run claude`)
                 → Codex CLI (`rly run codex` only)
       ↓ client protocol
Data plane
  ├─ decode and derive required capabilities
  ├─ request-time eligibility and account selection
  ├─ immutable EffectiveRoute with credential generation
  ├─ direct, OAuth, interoperability, or bridge adapter
  └─ protocol-preserving canonical event encoding
```

The Anthropic Messages protocol adapter and encoder are registered into the
foreground gateway when declarative direct routes, a selected OAuth account, or
an activated profile exists. Profile activation is lease-scoped: `rly <profile>`
and `run claude --profile` issue a child token bound to that profile. Each request then
performs eligibility and account selection through the pool; the profile never
preselects an account. Requests without a profile child token keep the
previous resolve order: TOML direct routes, then a manually selected Codex
account. OpenAI Responses is mounted beside Anthropic Messages and keeps
Responses item/event order; it shares control-plane eligibility and
EffectiveRoute selection.

## Implemented local foundation

The foreground launcher, runtime ownership store, and loopback server establish a safe local boundary for later protocol work. The executable owners are [`src/cli/main.ts`](../src/cli/main.ts), [`src/runtime/gateway-lifecycle.ts`](../src/runtime/gateway-lifecycle.ts), and [`src/runtime/runtime-store.ts`](../src/runtime/runtime-store.ts).

- `rly <profile>` launches Claude Code with that profile. `run claude` remains compatibility; `run codex` is the Codex CLI escape hatch. Both acquire one deterministic local gateway before launching the child; the child receives gateway settings without persistent global Claude or Codex configuration changes.
- Reuse requires a matching ownership record, process-start identity, config fingerprint, and fresh identity challenge proof. An occupied but unattested listener fails closed.
- Runtime files are outside Git, restricted to the current user, and reject link replacement. Startup and lease mutations use ownership-aware locking.
- Leases are heartbeated, expire after launcher loss, and trigger bounded idle cleanup. Diagnostics surface only an attested-compatible, foreign, stale, or absent lifecycle state.

## Core contracts

### Client protocol adapter

- Decodes one client protocol into a tagged canonical request.
- Encodes canonical events back to the client protocol.
- Derives required capabilities before route invocation.
- Reports unsupported or lossy translations explicitly.

The implemented Anthropic adapter covers the Messages request shape used by the
contract fixtures: text, base64 images, tools/results, thinking and redacted
thinking input, tool choice, selected inference controls, stream preference,
beta metadata, and cache-control placement. Its encoder produces Anthropic
message JSON or SSE for canonical text, thinking, tool-argument deltas, usage,
stop, and error events. See [protocol compatibility](./protocol-compatibility.md)
for the exact boundary and its exclusions.

### Canonical request

Contains source protocol/client metadata, requested model and role, ordered
system/input/messages content, tools/tool choice, inference controls, stream
preference, and approved extensions. The current source union includes
Anthropic Messages and OpenAI Responses. Both protocols have decoder/encoder
implementations. Responses also has a private continuation store.

Content is a tagged union: text, image, tool call, tool result, reasoning, and redacted reasoning. Arbitrary upstream passthrough is not part of the contract.

### Canonical event stream

Events cover response/item/content start and completion, text/reasoning/tool-argument deltas, usage updates, completion, and failure. Every event has request identity, monotonic sequence, timestamp, and provenance.

### Policy revision and EffectiveRoute

Control plane publishes a versioned policy/configuration snapshot. Once a request is decoded, the route selector derives required capabilities, filters current account eligibility, applies the configured strategy, and creates one immutable `EffectiveRoute`. It records provider, model, adapter, account pseudonym, credential generation, source rule, policy revision, capability snapshot, and decision time; it never contains secret values or raw account identity.

### Provider adapter

- `probe`: reports readiness without leaking credential or account identity.
- `capabilities`: describes verified model behavior.
- `invoke`: returns canonical events and accepts cancellation.
- `countTokens`: optional and must declare quality.

## Direct provider boundary

Direct adapters resolve only allowlisted secret references. They never read arbitrary process environment names or committed raw secrets. OpenAI-compatible transport does not imply identical provider behavior; reasoning replay, tool support, errors, usage, and catalogs remain adapter-specific.

## Control-plane boundaries

### Credential broker

The broker is the only owner of project-managed credential persistence. It performs explicit import/login, refresh single-flight, generation compare-and-swap, atomic replacement, backup, and recovery. Secret records live outside Git and SQLite in a restrictive project-owned store or approved OS backend. Provider adapters receive request-scoped credentials and cannot independently persist them.

### Accounts and pools

Account metadata is separate from credentials. Account identity is unique per `(provider, pseudonym)`. Pool selection always filters paused, expired, authentication-unready, cooling, capability-incompatible, or terms-unaccepted accounts before applying manual pin, `round-robin`, `fill-first`, or an evidence-approved quota strategy. Quota-exhausted accounts are ineligible only while cooling and become recovery probes afterward. A request never changes account after the first response byte or tool event.

### Management

Management and data paths use separate routers/listeners even when hosted by one process. Data defaults to `127.0.0.1:17871`; management defaults to `127.0.0.1:17872`. Both share the attested instance lifecycle, collision preflight, and teardown contract but use separate secrets. CLI management uses a per-instance bearer. Browser access exchanges a launcher-issued, single-use, short-lived URL-fragment token for an `HttpOnly`, `SameSite=Strict` cookie, then removes the fragment from history. Management enforces exact loopback Origin, CSRF, bounded sessions, versioned mutations, migration/recovery, and secret-free DTOs. UI never reads stores directly.

## Managed bridge boundary

Managed bridges are semi-trusted external dependencies. The gateway verifies configured endpoint, identity, version, protocol, and capabilities. They remain available when a provider is better served by bridge-owned installation, OAuth, accounts, refresh, or process lifecycle.

Readiness has three states:

1. reachable;
2. authenticated;
3. requested model usable.

Unknown identity or protocol-breaking version fails closed.

## Runtime and ownership invariants

- Loopback-only default endpoint: `127.0.0.1:17871`.
- Transient gateway token authenticates harness requests.
- Atomic startup lock must prevent duplicate races.
- Ownership record must include PID/start identity, instance UUID, executable/config fingerprint, nonce hash, launcher owner, and active leases.
- Reuse must require matching attestation and config.
- Foreign port owner must never be signaled.
- Gateway must shut down only according to its own leases and grace period.

## Data and persistence

SQLite owns versioned non-secret provider/account/profile/pool/health/policy/audit metadata and migrations. Project-owned OAuth secret records live outside SQLite and Git with restrictive permissions and atomic persistence. Runtime ownership files remain separate from business/control-plane state. Response or prompt bodies are not durable control-plane data.

## Observability

Structured logs default to metadata only. Route trace explains an explicit decision without prompt or secret data. Liveness is minimal; readiness is authenticated and route-specific.

## Compatibility strategy

- Protocol fixtures carry client/protocol version evidence.
- Registry records `registryRevision`, model `verifiedAt`, fixture revision, and token-count quality.
- Unknown required behavior disables readiness rather than silently degrading.
- Protocol drift begins with a redacted reproducing fixture.

## Security boundaries

- Loopback is not sufficient; transient authentication is mandatory.
- No retry after response first byte or a tool event.
- No global client configuration mutation.
- No silent credential discovery/import.
- Credential broker owns all project-managed secret writes.
- Management API never returns raw secret or account identity.
- Pool selection binds one credential generation per request and cannot rotate after output begins.
- No prompt/body logs by default.
- Existing services on protected ports are outside project ownership.

## Architecture decisions

- [Protocol-preserving IR](./adr/0001-protocol-preserving-ir.md)
- [Managed bridge boundary](./adr/0002-managed-bridge-boundary.md)
- [Transient launcher ownership](./adr/0003-transient-launcher-ownership.md)
- [Self-owned control plane and credentials](./adr/0004-self-owned-control-plane-and-credentials.md)
- [Request-time account routing](./adr/0005-request-time-account-routing.md)

## Unresolved questions

- Exact provider interoperability modes after the first Codex OAuth slice remain evidence-driven.
