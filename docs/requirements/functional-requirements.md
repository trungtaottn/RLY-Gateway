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
- macOS LaunchAgent specifics (#33): one stable per-user `com.rly.gateway` label and plist in the current user's GUI launchd domain, never root; absolute executable/state paths; `RunAtLoad` plus bounded `KeepAlive`/`ThrottleInterval` crash restart; service stdout/stderr into the durable RLY log directory; idempotent repair that unloads stale definitions before reloading; launchctl v2 (`bootstrap`/`kickstart`/`bootout`/`print`) with legacy `load`/`start`/`unload`/`list` tolerance; registration/load state reported separately from runtime `/identity` readiness.
- Linux `systemd --user` specifics (#34): one stable per-user unit `rly-gateway.service` under `~/.config/systemd/user` (mode `0600`, directory `0700`), never root; absolute executable/entrypoint/config paths plus durable `~/.rly` `WorkingDirectory`; `Restart=on-failure` with explicit `RestartSec` and a bounded `StartLimitIntervalSec`/`StartLimitBurst` policy so repeated broken startups become a diagnosable `failed` state instead of an uncontrolled tight loop; service stdout/stderr appended into the durable RLY log directory (`~/.rly/logs/service.log`), journal default otherwise; a reachable user systemd manager (user D-Bus) is probed before any mutating operation and a session without one (containers/minimal distros/WSL) fails actionably with explicit guidance that RLY never auto-enables `loginctl enable-linger`; `daemon-reload` runs only when the definition changed; idempotent repair never duplicates the unit; `systemctl --user` enable/start/stop/restart/disable command construction stays centralized in the adapter; unit enabled/active/process state reported separately from runtime `/identity` readiness.
- Prohibition: no credential, token, or account identity in service definitions, logs, or diagnostics.
- Acceptance: AT-035, AT-036, AT-040.

### FR-019 — Operate the `rly config` user control plane

- Traces: BR-002, BR-007, SR-F-023, SR-NF-002/004.
- Preconditions: `rly init` has completed (durable `~/.rly` installation record) or an explicit `--config` path is provided; an attested compatible runtime is reachable or recoverable.
- Behavior: resolve durable configuration from the installation record so `rly config` works from any working directory without a local `gateway.config.toml`; ensure/recover the resident runtime before control-plane operations (reuse an attested launcher-owned instance as-is, start the registered per-user service when it is down, fall back to a session-scoped foreground runtime for uninitialized/dev checkouts, and fail closed on foreign or incompatible listeners); provide a secret-free status summary and a local loopback UI bootstrap through the existing single-use fragment session contract; create/list providers, accounts, pools, and profiles through the same management endpoints and DTOs as `rly admin` so both surfaces observe exactly one policy revision; perform credential login/import/refresh/revoke through the credential broker persisting only handle/generation metadata.
- Failure: an uninitialized home, a missing recorded config, a foreign or incompatible runtime, a stale versioned mutation, an invalid pool/profile, or a credential failure returns an actionable error with no partial state and no secret, token, or account identity in output.
- Constraint: closing the config UI never stops the resident runtime; `--headless` prints the bootstrap URL without opening a browser.
- Acceptance: AT-048, AT-049, AT-050, AT-051, AT-052.

### FR-020 — Compose the RLY Claude configuration overlay

- Traces: BR-008, BR-009, SR-F-015, SR-F-024, SR-NF-002.
- Preconditions: a Claude launch is requested (`rly <profile>` or `rly run claude`) and the durable RLY control-plane directory is resolvable.
- Behavior: before launching Claude, prepare the durable RLY Claude overlay under `<control-plane>/claude` (`0700` directories, `0600` files, atomic writes) and point the child `CLAUDE_CONFIG_DIR` at it; compose the native user Claude config root (parent `CLAUDE_CONFIG_DIR` or `~/.claude`) as read-only input through a typed allowlist: `settings.json` one-way merge (strip `env` keys that conflict with the child-only gateway contract; keep unrelated settings and the native `model` as user input; preserve a previously persisted RLY-only projection model as RLY-owned state); user `agents/*.md`, `commands/*.md`, and `skills/**` one-way refresh copies; `plugins/config.json` with only the enablement declaration (`enabledPlugins`/`marketplaces`) and credential-bearing keys dropped. Never copy unknown files, plugin cache/repos, history, or runtime state; never read or write `~/.claude.json`; never touch project-local `.claude`.
- Refresh policy: an allowlisted file is composed when missing or when the native file is newer; unchanged native input leaves the overlay untouched so sibling sessions' `/model` writes survive; native deletions are not propagated (RLY state is additive); malformed native JSON surfaces are skipped, never rewritten or failed over.
- Model isolation: an RLY-only projection model id persisted by Claude `/model` (Enter/direct) lives only in the overlay settings; RLY gateway `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` are child-env only and never persisted in overlay settings; a subsequent plain `claude` launch reads native state only.
- Concurrency: RLY's own writes are atomic and deterministic from native input, so concurrent RLY launches converge without locks; RLY never copies back or restores native settings on exit.
- Diagnostics: `rly status` reports overlay directory/source/allowlist version/composition timestamp only; no settings, agent, plugin, session, or credential content.
- Failure: an unresolvable control-plane home or unreadable overlay write returns an actionable error and the launch does not proceed with a throwaway sandbox.
- Acceptance: AT-065, AT-066, AT-067, AT-068, AT-069, AT-070, AT-071, AT-072.

### FR-021 — Resolve Claude Code subagent model requests

- Traces: BR-001, BR-005, BR-008, BR-009, SR-F-025, SR-NF-002.
- Preconditions: a launch session with an activated Claude profile is bound to a live lease; the request carries the launch child token.
- Behavior: capture Claude Code agent attribution headers (`X-Claude-Code-Session-Id`, `X-Claude-Code-Agent-Id`, `X-Claude-Code-Parent-Agent-Id`) at the Anthropic ingress as typed runtime context on the canonical request, without inspecting prompt content; maintain a session-scoped in-memory execution-context registry bound to the launch session/lease (access provider, frozen physical model id, model family, effective tier, mapping/registry revisions) that disappears on lease revocation or runtime restart; resolve a subagent request's tier in its parent's execution context (exact parent-agent match, then the session's main context, then the launch session's profile-default model when unambiguous); pass the parent's resolved model/family into #69 tier resolution, then #68 capability selection and #70 reasoning translation, then the existing account pool for the frozen target.
- Isolation: a subagent's resolution never mutates the parent/main session's model, profile mapping, or global Claude settings; concurrent subagents with different agent ids resolve independently without context leakage.
- Reasoning: explicit subagent `effort` (documented `low`/`medium`/`high`/`xhigh`/`max`) is preserved through the canonical reasoning request and #70 translation; a tool-using subagent with an explicit reasoning intent requires reasoning-with-tools evidence and fails closed otherwise.
- Failure: unknown tier, missing evidence, unsatisfied capability, reasoning-with-tools gap, or an undeterminable parent/session family produce actionable typed errors (`tier-unavailable`, `capability-rejected`, plus the underlying cause); there is no silent fallback to the parent model, no global subagent model override, and no prompt-derived routing.
- Trace/privacy: route traces may carry allowlisted pseudonyms (hashes) of Claude session/agent/parent ids plus the parent model/family that scoped tier resolution; never prompts, credentials, or durable user identity.
- Acceptance: AT-084, AT-085, AT-086, AT-087, AT-088, AT-089, AT-090.

### FR-021 — Expose the trusted RLY model universe through Claude gateway discovery

- Traces: BR-001, BR-005, BR-009, SR-F-025, SR-NF-002.
- Preconditions: the gateway listener is up and authenticated; at least one enabled control-plane provider has an eligible pool; the model registry has trusted evidence.
- Behavior: expose an authenticated `GET /v1/models` on the gateway listener (not the management listener) matching the supported Claude Code discovery wire contract: `{ data: [{ type: "model", id, display_name, created_at }], has_more, first_id, last_id }` with `limit`/`before_id`/`after_id` pagination. Serve the launch session's pinned model universe when the request carries a launch-session child token, or the universe derived from the current control-plane policy for the instance bearer. Project only trusted registry models from enabled configured provider→pool bindings: `VERIFIED` compatibility by default, `EXPERIMENTAL` only with the explicit `gateway.modelDiscovery.experimentalModels` config opt-in, `BROKEN`/unreviewed/proposed targets never. Every discoverable id uses the Claude-compatible RLY projection namespace (`claude-rly-...`); the same upstream model through two access providers gets two distinct ids/display labels because auth/pool/endpoint/terms differ. Maintain an explicit reverse mapping (projection id → exact access-provider/model target + pinned pool); routing never parses id strings. An exact projected model routes through #68/#70 validation and the pinned provider pool's account selector; an unknown, removed, BROKEN, or ineligible projection target fails closed with a typed error and never substitutes another model or provider. Pin the session's universe (policy revision/hash, registry revision, bindings, experimental policy) at launch-session issue time so a policy/registry change never silently remaps an already-issued projection id mid-session.
- Child launch: RLY-launched Claude sessions receive child-only `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` (the parent/global environment is unchanged) and the overlay strips that key from native settings env so RLY sessions cannot be silently disabled; a plain `claude` launch never inherits RLY discovery env, auth, or projection ids.
- Diagnostics: `route-trace` shows projection id/display name as allowlisted routing metadata followed by the exact access-provider/model and account decisions; discovery responses and traces never contain credentials, authorization headers, account identity, prompts, or responses.
- Failure: an unauthenticated request is rejected; an unknown/ineligible projection id, a missing provider/pool, or no policy returns an actionable typed error without partial state or secrets.
- Acceptance: AT-073, AT-074, AT-075, AT-076, AT-077, AT-078, AT-079, AT-080, AT-081, AT-082, AT-083.

## Unresolved questions

- Exact quota-aware strategy behavior after live quota evidence is pinned.
