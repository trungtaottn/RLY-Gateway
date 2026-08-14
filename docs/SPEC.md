# RLY Gateway Product Specification

| Attribute | Value |
| --- | --- |
| Document | Build-ready product and system specification |
| Version | 0.2 |
| Baseline date | 2026-08-13 |
| Status | Approved control-plane baseline |
| Product | RLY Gateway |
| Coding harness | Claude Code CLI |
| Profile alias | `rly <profile>` launches Claude Code |
| Codex CLI | `rly run codex` escape hatch only |
| Delivery posture | Private-first, public-ready |

## 1. Purpose

RLY Gateway is a local subscription orchestration fabric. Claude Code is the single coding-harness UX: `rly <profile>` launches Claude Code with that RLY profile. Provider names are not harnesses. The product owns a local control plane for provider accounts, credentials, profiles, pools, health, and routing policy while preserving client protocol semantics instead of flattening every request into generic chat completions.

## 2. Product outcome

The completed protocol milestone runs Claude Code through a local gateway with correct Anthropic Messages behavior and verified direct-provider routing. The next milestone adds a self-owned credential broker and deterministic account control plane, beginning with Codex OAuth accounts used through Claude Code. Codex CLI remains an explicit `rly run codex` escape hatch through an OpenAI Responses boundary; it is not a parallel product UX.

## 3. Users and operating context

- Initial user: repository owner on a personal macOS workstation.
- Deployment: per-user resident loopback service in V1, with a foreground loopback fallback when no service is initialized. `rly init` installs the resident runtime; `rly <profile>` reuses it.
- Usage: interactive coding-agent sessions, including tools, reasoning, images, streaming, and cancellation.
- Maintenance: frequent provider/model/CLI updates with fixture-first compatibility work.

## 4. Harness scope

Claude Code is the single coding harness. A profile name is the user-facing alias: `rly codex`, `rly clinepass`, and `rly deepseek` each launch Claude Code with that RLY profile. `rly run claude --profile <name>` remains compatibility. `rly run codex` launches Codex CLI and is not a provider alias. Do not add a separate Alias type.

### 4.1 Claude Code — canonical harness

Required behavior:

- Anthropic `POST /v1/messages`, streaming and non-streaming, after the
  protocol boundary is connected to an enabled provider route.
- `POST /v1/messages/count_tokens` with declared accuracy quality, after the
  route's provider behavior is verified.
- Text, images, tool use, tool results, tool choice, thinking, and redacted thinking.
- Incremental text, reasoning, and tool-argument deltas.
- Usage and stop-reason fidelity.
- Cancellation, backpressure, structured errors, and safe retry boundaries.
- Explicit `primary`, `fast`, and `reasoning` model roles.
- Child-only gateway environment over a durable RLY Claude configuration overlay (`~/.rly/claude`): the user's native Claude settings/agents/skills/plugins are composed as read-only input, RLY session/model state persists inside the overlay, and global Claude configuration remains unchanged.

### 4.2 Codex CLI — `rly run codex` escape hatch

Required for the explicit Codex CLI launch path, not as a peer coding UX:

- OpenAI Responses request/item/event lifecycle.
- Streaming, function-call argument deltas, reasoning, usage, errors, and cancellation.
- Transient launch configuration; global Codex configuration remains unchanged.
- Fake-upstream E2E before subscription bridge integration.

## 5. Backend scope

| Backend | Type | Delivery order |
| --- | --- | --- |
| OpenRouter API | Direct API | First Claude route |
| DeepSeek API | Direct API | Second Claude route |
| OpenAI/Codex subscription | Project-owned OAuth or attested bridge | First control-plane vertical slice |
| Claude subscription | Project-owned OAuth or attested bridge | After credential broker and pool engine |
| Google Antigravity | Project-owned OAuth or attested bridge | Provider expansion |
| Google Gemini / Code Assist | Project-owned OAuth | Provider expansion |
| ClinePass | Explicit interoperability adapter | Provider expansion |
| OpenCode Go | Direct coding-plan API | Provider expansion |
| Alibaba Token Plan | Direct or OAuth adapter | Local-only, terms-gated provider expansion |

Additional providers remain outside V1 until promoted through the provider contract and provenance gates.

## 6. Functional requirements

### 6.1 Routing

- Route selection is explicit by provider/model or approved model role.
- Route and capability snapshot are immutable for one request.
- Required unsupported semantics are rejected before upstream invocation.
- Model capability selection (#68) is a deterministic stage before account selection: it picks one eligible physical model from the trusted model intelligence registry (capabilities, reasoning, compatibility) and freezes it into the effective request/route; the pool selector then chooses the account/credential without changing the model.
- Claude Code subagent requests (#71): the gateway captures Claude Code agent attribution headers as typed runtime context, resolves a subagent's portable model tier inside its parent agent's execution context (exact parent → session main → unambiguous launch-session default), and routes through the same #69 → #68 → #70 → account-pool stages while the parent/main session stays on its model; undeterminable families and unsatisfied capabilities fail closed with actionable causes. RLY never inspects prompts, never runs a workflow engine, and has no global subagent model override.
- No prompt-derived routing or silent provider substitution.

### 6.2 Provider adapters

- Direct adapters resolve approved credential references at request time.
- Each model has evidence-dated capabilities and token-count quality.
- The model intelligence registry (`src/registry/model-registry.ts`) is the canonical evidence source for provider/model identity, capability, limits, reasoning controls, and compatibility state (#67); discovery proposes, it never silently rewrites reviewed evidence (#23). `rly admin models refresh` queries or imports a provider catalogue, normalizes it into candidate evidence, diffs it against reviewed evidence, and emits/persists a deterministic propose-only drift report; it never activates or mutates trusted evidence, and promotion requires a separate reviewed control-plane operation (#69/#72).
- Provider-specific behavior remains in its adapter even when transport is OpenAI-compatible.
- Runtime probes never silently rewrite the committed registry.

### 6.3 Credentials and accounts

- Credential broker owns project-managed import, login, refresh, generation, locking, atomic persistence, and recovery.
- Secret records live in a project-owned `0700` directory with `0600` files or an approved OS secret backend; SQLite stores metadata and handles only.
- Import from another client store is explicit and read-only by default. Continuous interoperability is provider-specific, opt-in, schema-pinned, locked, backed up, and recovery-tested.
- Account metadata is distinct from credential material and records ownership, provider, state, pause reason, terms acknowledgement, health, and credential generation.
- Refresh is single-flight per credential and commits through compare-and-swap generation so stale refreshes cannot overwrite newer credentials.

### 6.4 Pools and request-time routing

- Eligibility filtering precedes account selection. Paused, expired, authentication-unready, cooling, capability-incompatible, or terms-unaccepted accounts are ineligible. Quota-exhausted accounts are ineligible only while cooling; after cooldown they are recovery probes. Success restores healthy; probe failure extends cooldown.
- Initial selection supports manual pinning, `round-robin`, and `fill-first`; quota-aware selection follows only with evidence-backed quota state.
- One request binds one account pseudonym and credential generation in an immutable `EffectiveRoute`.
- Retry or account rotation is allowed only before the first response byte or tool event and within a bounded, auditable budget.
- Control plane publishes versioned policy/configuration. The data plane creates `EffectiveRoute` only after deriving request capabilities and selecting an eligible account.

### 6.5 Managed bridges

- A bridge may own OAuth, refresh, account state, installation, and lifecycle when selected instead of a project-owned provider adapter.
- Gateway checks configured identity, protocol, version, and capabilities.
- Readiness distinguishes reachable, authenticated, and model usable.
- Wrong identity or breaking version fails closed.
- V1 supports loopback bridges only.

### 6.6 Control plane and management

- Local admin API owns provider, account, profile, pool, health, policy, and metadata-only audit mutations.
- Management and data APIs have separate router/listener boundaries even if one process hosts both.
- Data defaults to `127.0.0.1:17871`; management defaults to `127.0.0.1:17872`. Both use the existing read-only collision preflight and instance attestation; a foreign listener fails closed and is never signaled or bypassed with another port.
- CLI management uses a separate per-instance bearer secret from a restrictive runtime record. Browser management starts only from a launcher-issued, single-use, short-lived fragment token exchanged for an `HttpOnly`, `SameSite=Strict` session cookie; the fragment is removed from browser history after exchange.
- Management requires exact loopback Origin validation, CSRF protection on mutations, versioned mutations, bounded sessions, explicit logout, and migration rollback. The management listener stops with the attested gateway instance.
- Management DTOs never expose secret values, raw account identity, prompts, responses, or authorization material.
- UI follows the tested management contract; it never reads credential files directly.
- `rly config` is the primary post-install user control plane: it resolves durable configuration from the `~/.rly` installation record (no CWD `gateway.config.toml` on the normal installed path), ensures/reuses the resident runtime, and operates providers/accounts/pools/profiles/credentials through the same management endpoints and policy revision as `rly admin`.

### 6.7 Launcher and lifecycle

- Deterministic default endpoint `127.0.0.1:17871` after collision preflight.
- A transient gateway token authenticates local requests.
- Ownership evidence includes process start identity, instance identity, config fingerprint, and leases.
- Compatible concurrent sessions may reuse an attested instance.
- `rly init` registers the per-user resident service (macOS LaunchAgent or Linux `systemd --user`) and starts it; the resident runtime owns a service lease renewed by its own process so the zero-lease idle shutdown never fires while the service is intentional.
- `rly <profile>` and diagnostics reuse the same attested resident runtime; closing a Claude/Codex child releases only its launch/session lease and never stops the resident service.
- RLY-launched Claude sessions point `CLAUDE_CONFIG_DIR` at the durable RLY Claude configuration overlay (composed from native user config through a typed allowlist; see FR-020/SR-F-024); RLY-only gateway/model state lives only in the overlay and a later plain `claude` launch is unaffected. Codex keeps its throwaway `CODEX_HOME` isolation.
- Explicit service stop revokes launch sessions and closes boundedly through the existing shutdown safety logic; a foreign or unattested listener is never signaled.
- Foreign listeners are never killed and do not cause port auto-increment.
- Signals and cancellation propagate to active upstream work.

### 6.8 Diagnostics

Allowed by default:

- request ID;
- provider/model/route identifiers;
- capability and readiness states;
- version, timing, and status metadata.

Forbidden by default:

- prompts or responses;
- raw credentials or authorization headers;
- email or account identity;
- captured real provider payloads.

## 7. Quality attributes

- Correctness: byte/event-order golden contracts for supported client protocols.
- Isolation: concurrent requests cannot share mutable route state.
- Safety: no retry after response first byte or tool event.
- Privacy: secret and payload redaction is a release gate.
- Recoverability: native client path remains available because global config is not persisted.
- Maintainability: provider changes require fixtures, capability evidence, and compatibility-document updates.

## 8. V1 non-goals

- Remote or multi-user control plane.
- System-wide/root daemon shared by multiple OS users.
- Weighted, cost, prompt-derived, or unbounded automatic-failover routing.
- Generic provider/plugin marketplace.
- Silent credential discovery or import.
- Persistent global Claude/Codex configuration (RLY Claude configuration state lives only in the RLY-owned overlay under `~/.rly`; native Claude config is never rewritten).
- Prompt-derived routing.
- Hot reload within an active request.

## 9. Acceptance criteria

### Claude MVP

- Real Claude Code completes text and tool round trips against fake upstream.
- Helper role selects the configured route without contaminating another request.
- Ctrl-C aborts upstream work and cleans project-owned processes.
- Two concurrent sessions pass lifecycle and route-isolation tests.
- One direct provider passes opt-in text, stream, tool, usage/stop, and token-count smoke.
- Global Claude configuration fingerprint is unchanged by controlled E2E.
- Existing protected processes/ports are unchanged.
- Offline protocol, lifecycle, privacy, lint, typecheck, and build gates pass.

### V1

- Project-owned Codex OAuth credentials pass import/login/refresh/expiry/concurrency/recovery gates.
- OAuth callback tests cover PKCE verifier/challenge, exact redirect address, state mismatch/replay/expiry, callback port collision, bounded error bodies, and cancellation.
- Logout/revoke removes active, temporary, and backup secret records after upstream revocation where supported; verification proves no project-owned usable credential remains. Filesystem deletion is not claimed as forensic media erasure.
- Manual account selection, pause, eligibility, deterministic pool routing, cooldown, and bounded pre-stream rotation pass race/crash tests.
- Management API never returns secrets and rejects unauthenticated, cross-origin, stale-version, and invalid-CSRF mutations.
- Codex CLI passes Responses fake-upstream E2E.
- Every enabled adapter passes its declared contract and opt-in smoke.
- Bridge mismatch and auth-expiry tests fail safely.
- Clean install/package, provenance, dependency-license, and privacy gates pass.

## 10. Sources and precedence

1. Explicit owner decisions.
2. This `SPEC.md` product contract.
3. Accepted ADRs and `docs/ARCHITECTURE.md`.
4. Active plan phase files for execution detail.
5. Research reports and upstream sources as evidence, not authority.

When sources conflict, do not silently reinterpret scope; update the owning authority explicitly.

## Unresolved questions

- First provider adapter is project-owned Codex OAuth; additional providers choose project-owned OAuth, explicit interoperability, direct API, or attested bridge from evidence and owner decision.
- Initial local UI scope follows the management contract and does not block credential broker or pool acceptance.
- Live model-role mappings depend on current catalogs and owner preference.
