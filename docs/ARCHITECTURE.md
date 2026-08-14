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

## Persistent per-user resident runtime

`rly init` promotes the same foreground gateway into a per-user resident service without a second daemon or data plane:

- `rly init` settles the durable `~/.rly` home, validates the control-plane store, registers the per-user service (macOS LaunchAgent / Linux `systemd --user`, idempotent, no root), starts it, and waits for an attested compatible resident runtime.
- Resident ownership is a service lease renewed by the resident process itself, so the zero-lease idle shutdown never fires while the service is intentional. Child launch/session leases stay independent and revocable; closing a Claude/Codex child releases only its lease.
- `rly <profile>`, `rly config`, and diagnostics reuse the same attested resident runtime; the foreground launcher remains the fallback when no service is initialized.
- Explicit service stop is an attested, authenticated in-process `/shutdown` request: revoke launch sessions, bounded close, close broker/control-plane, clean owned runtime artifacts. An unknown port owner is never signaled.
- Crash recovery uses service-manager restart plus the existing startup-lock/process-identity rules; stale records are recovered and foreign listeners fail closed.
- `/identity` carries `runtimeVersion` and `resident` metadata for the version/protocol handshake (#73 update decisions). Platform specifics are owned by #33 (launchd) and #34 (systemd). See [ADR 0006](./adr/0006-persistent-user-runtime-service.md).

### User configuration control plane (`rly config`)

`rly config` is the primary user-facing control plane after `rly init` (#66). It productizes the existing management/control-plane boundary instead of composing low-level `rly admin` commands or hand-editing `gateway.config.toml`:

- Durable configuration resolution: `rly config` reads the `~/.rly/installation.json` record written by `rly init` and loads the recorded absolute config path, so it works from any working directory without a local `gateway.config.toml`. Explicit `--config` and the CWD file remain explicit dev/operator paths only; a missing recorded file falls back to the schema defaults (default loopback endpoints).
- Runtime ensure/recover: before any operation it inspects the attested runtime. A compatible resident or launcher-owned instance is reused as-is; when the resident service is installed but not running, the service manager starts it and the CLI waits for an attested compatible instance; uninitialized/dev checkouts fall back to a session-scoped foreground runtime. Foreign or incompatible listeners fail closed and are never signaled.
- Surface: bare `rly config` (or `rly config ui`) opens the local loopback config UI through the existing single-use fragment bootstrap (`/auth/bootstrap` → `HttpOnly`/`SameSite=Strict` session) and prints the URL in `--headless` mode; `rly config status` prints a secret-free summary (runtime state, policy revision, resource counts, health). Focused shortcuts (`providers`, `accounts`, `pools`, `profiles`) create/list through the same management endpoints and DTOs as `rly admin`, so both surfaces observe exactly one policy revision and cannot diverge into separate sources of truth.
- Credential flows reuse the credential broker: login/import/refresh/revoke persist only handle/generation metadata outside secret storage; the privacy allowlist is preserved end to end. Closing the config UI never stops the resident runtime.

### Platform service adapters

`src/service-manager/` implements the per-user service contract per OS; command construction stays centralized there so init/update/status never grow separate launchctl/systemctl strings. The macOS LaunchAgent adapter (#33) installs one plist (`com.rly.gateway`) under `~/Library/LaunchAgents` (mode `0600`, directory `0700`), targets the current user's `gui/<uid>` domain without root, and refuses to run as root. It tolerates both launchctl v2 (`bootstrap`/`kickstart`/`bootout`/`print`) and legacy (`load`/`start`/`unload`/`list`) subcommands, repairs changed/stale definitions by unloading before reloading so launchd never keeps pointing at an old executable, bounds crash-restart with an explicit `ThrottleInterval`, writes service stdout/stderr into the durable RLY log directory, and removes only RLY-owned files on unregister (durable `~/.rly` data is never deleted). Service registration/load state and pid (`launchctl print`/`list` parsing) are reported separately from runtime `/identity` readiness; `rly status`/`rly gateway status` surface both using the privacy allowlist. The Linux `systemd --user` adapter (#34) installs one per-user unit (`rly-gateway.service`) under `~/.config/systemd/user` (mode `0600`, directory `0700`), never runs as root, and probes for a reachable user systemd manager (user D-Bus) before any mutating operation; a session without one (containers/minimal distros/WSL variants) fails actionably with explicit guidance that RLY never auto-enables `loginctl enable-linger`. The unit uses absolute executable/entrypoint/config paths and the durable `~/.rly` working directory, bounds crash-restart with `Restart=on-failure` plus explicit `RestartSec` and `StartLimitIntervalSec`/`StartLimitBurst`, appends service stdout/stderr into the durable RLY log directory, and holds no `Environment=` or credential/identity content. `daemon-reload` runs only when the definition changed, so re-running init repairs stale definitions without duplicate units; unregister `disable --now`s and removes only the RLY-owned unit (durable `~/.rly` data is never deleted). Unit enabled/active/process state (`systemctl --user show` parsing) is reported separately from runtime `/identity` readiness and surfaced by `rly status`/`rly gateway status` on the same privacy allowlist.

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

### Model selection and account selection (two-stage boundary)

Model selection is a deterministic stage that runs **before** account selection (#68). Given an access provider, an optional preferred model family, an optional exact physical model pin, the decoded request's required capabilities, and a reasoning intent, the capability matching engine (`src/routing/model-selection/`) retrieves candidates from the trusted model intelligence registry, applies hard eligibility (exact evidence, protocol capabilities via the existing `CapabilityRequirement` semantics, reasoning semantics from `ReasoningCapabilityEvidence`, and compatibility state), then ranks deterministically in reviewed registry document order. It returns one frozen physical `ModelEvidence` target plus a secret-free decision trace; a typed failure (`unknown-exact-model`, `no-trusted-evidence`, `capability-unsupported`, `reasoning-unsupported`, `compatibility-rejected`, `no-eligible-candidate`) is raised when no candidate is eligible. The existing `RouteSelector` still owns account eligibility, affinity, quota, pin order, retry safety, and credential generation within one pool; it never selects between physical models, and account retry/failover cannot change the frozen model. `BROKEN` compatibility is always rejected; `EXPERIMENTAL` is rejected by the default normal-user policy on the candidate path and requires an explicit opt-in (an explicit exact-model pin is itself an opt-in for that exact model). #69 owns tier/family preference ranking and cross-family fallback policy; #70 owns full reasoning-intent translation.

### Provider adapter

- `probe`: reports readiness without leaking credential or account identity.
- `capabilities`: describes verified model behavior.
- `invoke`: returns canonical events and accepts cancellation.
- `countTokens`: optional and must declare quality.

## Model intelligence registry

The registry in [`src/registry/model-registry.ts`](../src/registry/model-registry.ts) is the canonical model-data layer and the source of truth for provider/model identity and evidence (#68-#72). It records, per exact access path:

- `identity`: access provider, exact upstream model id, and upstream/model family (classification metadata only — never a route, credential, or account key).
- capability evidence: the protocol flags (`ProviderCapabilities`) plus typed reasoning controls (effort kind/levels, adaptive, token budget, reasoning-with-tools) and reviewed operational limits (context window, max output) when evidenced.
- compatibility state: `VERIFIED`/`EXPERIMENTAL`/`BROKEN` for the RLY Claude Code baseline, kept separate from raw capability support, with the tested baseline, evidence reference, and check date.
- provenance: `verifiedAt`, fixture version, and registry document revision.

Invariants:

- Exact `(accessProvider, upstreamModelId)` matching only; the same upstream model id reachable through two access providers stays two separately verified entries and never satisfies each other's lookup. Missing or cross-provider evidence fails closed.
- One canonical shape covers native/direct, OAuth/bridge, ClinePass, and OpenRouter/aggregator paths. Aggregators expose many model families without extra provider records or parallel registries.
- Provider probes and catalog discovery report drift but never mutate the trusted document; discovery diffs against reviewed evidence and returns proposed candidates for the #23 propose-only review workflow.
- **Propose-only catalog refresh (#23 / BL-042):** `rly admin models refresh|proposals` runs the discovery pipeline (`src/providers/catalog-discovery.ts` → `src/registry/catalog-proposal.ts` → `src/registry/proposal-store.ts`) and persists a deterministic drift report (new / changed / removed / unchanged + reviewed evidence references) as a metadata-only artifact under `<control-plane>/proposals/<provider>.json` — **separate from trusted evidence**. The refresh command never mutates the trusted registry, profile tier mappings, `/v1/models` projections, or active session policy; promotion of proposed evidence is a separate reviewed control-plane operation (#69/#72). Provider-reported fields (tools/reasoning/limits) are labeled declared/observed until reviewed; #24 canary references are carried from reviewed entries only and never fabricate a pass. Errors are privacy-redacted before output/persistence.
- No credentials, account identity, prompts, or responses are stored in model evidence or proposals.

Deterministic query helpers (`modelsForProvider`, `modelsForFamily`, `modelsSatisfying`, `modelsRequiringCapabilities`, `modelsWithCompatibility`) support #68/#69 candidate retrieval without account selection or credential access. Account/credential eligibility and selection remain owned by the pool/route selector.

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
- Gateway must shut down only according to its own leases and grace period; an intentional resident service holds a service lease so it never enters zero-lease idle shutdown.

## Data and persistence

SQLite owns versioned non-secret provider/account/profile/pool/health/policy/audit metadata and migrations. Project-owned OAuth secret records live outside SQLite and Git with restrictive permissions and atomic persistence. Runtime ownership files remain separate from business/control-plane state. Response or prompt bodies are not durable control-plane data.

## Observability

Structured logs default to metadata only. Route trace explains an explicit decision without prompt or secret data. Liveness is minimal; readiness is authenticated and route-specific.

## Compatibility strategy

- Protocol fixtures carry client/protocol version evidence.
- The model intelligence registry records `registryRevision`, model `verifiedAt`, fixture revision, token-count quality, reasoning/limit metadata, and typed compatibility state (baseline + evidence reference).
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
- [Persistent per-user runtime service](./adr/0006-persistent-user-runtime-service.md)

## Unresolved questions

- Exact provider interoperability modes after the first Codex OAuth slice remain evidence-driven.
