# Source Adaptation Matrix

This matrix is the only gateway from research source to implementation. No
source enters the repository without an artifact pin, license, destination,
classification, verification owner, and kernel-invariant review.

Authoritative machine-readable rows: [`provenance/adaptation-matrix.json`](./provenance/adaptation-matrix.json).
Artifact pins: [`provenance/artifacts.json`](./provenance/artifacts.json).

Classifications:

- `copied` — substantial source text will be committed (none in this freeze)
- `adapted` — later phases may follow the module's structure or algorithm
- `oracle-only` — consult for behavior; reimplement independently
- `rejected` — must not be used

## Planned reuse

| Id | Artifact | Source | Destination | Class | Owner |
| --- | --- | --- | --- | --- | --- |
| ccs-profile-target | CCS 8.9.0 | `src/targets/`, profile resolver | `src/profiles/`, `src/targets/` | adapted | profiles |
| ccs-transient-launcher | CCS 8.9.0 | environment builder, Claude adapter | `src/runtime/child-launcher.ts`, `src/cli/` | adapted | runtime |
| ccs-alias-normalization | CCS 8.9.0 | model-id normalizer | `src/profiles/`, `src/registry/` | adapted | profiles |
| ccs-account-quota-ux | CCS 8.9.0 | accounts, quota, commands | `src/cli/` | adapted | management |
| ccs-generated-config-semantics | CCS 8.9.0 | cliproxy config / dispatcher flows | none | oracle-only | profiles |
| opencodex-credential-cas | OpenCodeX 2.11.1 | oauth store, token guardian, Codex refresh | `src/credentials/` | adapted | credentials |
| opencodex-oauth-pkce | OpenCodeX 2.11.1 | pkce, callback, chatgpt oauth | `src/providers/oauth/codex/`, `src/credentials/` | adapted | credentials |
| opencodex-eligibility-pools | OpenCodeX 2.11.1 | usability, pool-rotation, quota evaluator | `src/routing/eligibility/`, `src/routing/pools/` | adapted | routing |
| opencodex-health-outcome | OpenCodeX 2.11.1 | runtime state, quota, routing health | `src/control-plane/health/` | adapted | routing |
| opencodex-management-dto | OpenCodeX 2.11.1 | management routes, auth, CORS | `src/management/` | adapted | management |
| opencodex-config-mutation | OpenCodeX 2.11.1 | storage mutation coordinator | `src/control-plane/`, `src/storage/` | adapted | control-plane |
| opencodex-protocol-oracles | OpenCodeX 2.11.1 | Claude / Responses servers | none | oracle-only | protocols |
| claude-proxy-helper-map | claude-proxy `6c21df81` | `adapters/map.ts` | `src/profiles/` | adapted | profiles |
| claude-proxy-provider-parse | claude-proxy `6c21df81` | openai-compat, SSE | `src/providers/` | adapted | providers |
| claude-proxy-codex-oauth | claude-proxy `6c21df81` | `adapters/providers/codex-oauth.ts` | `src/providers/oauth/codex/` | adapted | providers |
| claude-proxy-gemini-oauth | claude-proxy `6c21df81` | gemini-oauth, google-auth | `src/providers/oauth/gemini/` | adapted | providers |
| claude-proxy-sse-fixtures | claude-proxy `6c21df81` | SSE helpers | `tests/fixtures/upstream/claude-proxy/` | adapted | protocols |
| claude-proxy-cline-interop | claude-proxy `6c21df81` | cline-pass | `src/providers/interop/cline/` | adapted | providers |
| cliproxy-plus-bridge-oracle | Plus `v7.2.127-3` | release binary behavior | future attested bridge | oracle-only | providers |

## Rejected

| Id | Artifact | Why |
| --- | --- | --- |
| ccs-cliproxy-binary-manager | CCS 8.9.0 | Owns a foreign proxy and protected port `8317` |
| ccs-email-account-identity | CCS 8.9.0 | Email/account identity must not enter product data |
| opencodex-integrated-service | OpenCodeX 2.11.1 | Wholesale GUI/tray/update service |
| opencodex-native-config-mutation | OpenCodeX 2.11.1 | Persistent global Claude/Codex config |
| opencodex-port-reclaim | OpenCodeX 2.11.1 | Kill-by-port |
| opencodex-silent-token-detect | OpenCodeX 2.11.1 | Silent credential discovery |
| opencodex-payload-retention | OpenCodeX 2.11.1 | Prompt/response retention |
| claude-proxy-kill-by-port | claude-proxy | `lsof` + `SIGKILL` |
| claude-proxy-shared-store-default | claude-proxy | Silent import and default shared-store writes |
| claude-proxy-local-patches | local dirty tree | Not the pinned commit |
| cliproxy-plus-source | Plus binary/source | MIT proven; `+dirty` source tree; no Go copy |
| cliproxy-api-source | CLIProxyAPI 7.2.129 | Same license and dirty-binary caveat |

## Kernel invariant review

Every `adapted` row was checked against the current kernel. Later copy work
must preserve:

1. Loopback-only data/management listeners. Foreign listeners fail closed. No
   port auto-increment and no signal based only on occupancy.
2. Existing attested lifecycle, leases, and protected ports `10100`, `8317`,
   `17870` stay outside project ownership.
3. Credential directory `0700`, secret files `0600`, atomic write, backup,
   recovery. Secrets never enter SQLite, Git, logs, audit, or management DTOs.
4. Explicit, read-only import by default. Continuous shared-store
   interoperability is provider-specific and opt-in. CCS model-id remaps
   that substitute a different model stay rejected.
5. Refresh is single-flight with generation compare-and-swap.
6. Eligibility filtering precedes strategy. Paused, expired, unready,
   cooling, incompatible, or terms-unaccepted accounts are ineligible.
   Quota-exhausted accounts are recovery probes after cooldown.
7. One request binds one account pseudonym and credential generation. No
   rotation after the first response byte or tool event.
8. Management is a separate authenticated boundary with Origin/CSRF and
   versioned mutations.
9. Transient launch settings only. No persistent global Claude/Codex mutation.
10. Fixtures and diagnostics stay synthetic and secret-free.

Unresolved for later phases: whether any provider uses an attested CLIProxy
binary instead of a project-owned adapter. That choice cannot copy Plus/API
source. First UI field set is admin plus diagnostics on existing DTOs.
