# Acceptance Test Cases Catalogue

These are acceptance scenarios, not hand-maintained implementation test names. The RTM links requirements to scenario IDs; executable test paths are added as evidence when implemented.

| ID | Acceptance scenario | Expected result |
| --- | --- | --- |
| AT-001 | Start/reuse the gateway on deterministic ports | Only an attested compatible instance is reused; data and management listeners are loopback-only |
| AT-002 | Present foreign/stale listeners and interrupted runtime state | Fail closed without signaling foreign PIDs, auto-incrementing ports, or losing recoverable state |
| AT-003 | Create/update/disable a provider definition | Valid versioned mutation commits atomically and publishes a new policy revision |
| AT-004 | Submit unauthorized, stale, incompatible, or terms-incomplete provider mutations | Mutation is rejected with no partial state or secret-bearing error |
| AT-005 | Import a supported Codex credential | Project-owned restrictive record is created and source store remains byte-identical |
| AT-006 | Import malformed, changing, oversized, or unsupported source data | Import fails, temporary files are removed, and no secret appears in output/log/audit |
| AT-007 | Complete valid OAuth authorization | PKCE/state/exact callback validation succeeds and generation one is stored atomically |
| AT-008 | Replay/mismatch/expire state, collide callback, cancel, or return malformed OAuth data | Flow fails closed and leaves no usable partial credential |
| AT-009 | Trigger concurrent refresh for one generation | One upstream refresh/commit occurs and callers receive the committed generation |
| AT-010 | Complete stale/failed/interrupted refresh | Older result cannot overwrite newer generation; last valid record remains recoverable |
| AT-011 | Logout/revoke an account | New requests exclude it and no usable active/temp/backup project credential remains |
| AT-012 | Corrupt active credential or interrupt atomic replacement | Recovery selects only a schema-valid non-revoked generation or marks account unready |
| AT-013 | Pause/resume/pin account and inspect status | Versioned state changes apply; DTO contains pseudonym/readiness only |
| AT-014 | Use terms-gated account before/after acknowledgement revision changes | Unaccepted/stale acceptance is ineligible; current explicit acceptance enables eligibility |
| AT-015 | Create valid profile and pool | References, roles, strategy, affinity, retry budget, and ownership validate atomically |
| AT-016 | Submit duplicate/invalid/cross-provider/stale pool configuration | Mutation fails without changing current policy |
| AT-017 | Select from fixed eligible candidates under manual/RR/fill-first | Result and decision reason are deterministic and bind one credential generation |
| AT-018 | Include paused/expired/unready/cooling/incompatible/unaccepted candidates, plus quota-exhausted accounts that are still cooling | Every ineligible candidate is excluded before strategy evaluation; exhausted accounts whose cooldown has elapsed are recovery probes |
| AT-019 | Receive eligible pre-output auth/quota/transient failure | Transactional outcome update occurs and bounded rotation follows policy; quota success restores healthy and probe failure extends cooldown |
| AT-020 | Receive failure after first response byte or tool event | Failure propagates; no second account/provider invocation occurs |
| AT-021 | Run Claude text, stream, tool, thinking, helper, usage, and stop flows | Supported semantics and event order are preserved through the selected route, including a Codex OAuth Claude profile and a ClinePass Claude profile |
| AT-022 | Cancel Claude request and run concurrent profiles/sessions | Upstream aborts; route/account state does not contaminate sibling requests |
| AT-023 | Run Codex Responses text/function/reasoning/usage/continuation flows | Responses semantics are preserved without Anthropic flattening |
| AT-024 | Cancel/fail Codex Responses request or encounter unknown required event | Upstream aborts or route becomes unready; no silent loss/substitution occurs |
| AT-025 | Authenticate management CLI and browser | Separate bearer works; single-use fragment exchanges for a bounded secure cookie; fragment is removed from browser history and never appears in Referer, server access logs, or error output |
| AT-026 | Attempt cross-origin, invalid-CSRF, expired/replayed bootstrap, stale-version, logout/shutdown session use | Every attempt fails and no mutation occurs |
| AT-027 | Inspect status, trace, logs, audit, error, UI, export, and package | No raw credential, account identity, prompt, response, or tool argument is present |
| AT-028 | Adapt a substantial upstream module | Exact source/hash/license/path/classification/notice and verification owner are recorded in `docs/provenance.md`, `docs/provenance/adaptation-matrix.json`, and `docs/third-party-notices.md` |
| AT-029 | Bootstrap public baseline, then promote releases | Baseline snapshot contains approved public files in one commit and has no private `dev` ancestor; later reviewed promotion preserves normal ancestry |
| AT-030 | Execute release/traceability gate | Must requirements have evidence; verify/privacy/license/migration/recovery/package/clean-install gates pass |
| AT-031 | Operate every supported UI workflow with keyboard and accessibility inspection | Focus is visible/predictable; controls have programmatic labels; status/errors are textual; desktop/mobile layouts remain usable |
| AT-032 | Apply and interrupt retention/deletion policy across every durable class | Expired data becomes unreachable and is removed per policy; cleanup resumes idempotently after interruption; no revoked/expired secret becomes active |
| AT-033 | Launch `rly <profile>` as Claude Code alias | Named profile launches Claude Code with a child token; reserved commands stay reserved; unknown profile fails closed; `rly run codex` stays Codex CLI; global Claude/Codex config is unmodified |
| AT-035 | Bootstrap and operate the persistent per-user runtime service | `rly init` creates/validates the durable `~/.rly` home and registers the user service idempotently; generated macOS LaunchAgent and Linux `systemd --user` definitions and lifecycle commands are automated/platform-gated; the resident runtime starts after init without `rly gateway start`, stays alive after the last Claude/Codex child exits, and is reused by `rly <profile>` and concurrent launches with independent launch/session leases; a crash is restarted by the service manager and stale records recover without killing foreign listeners; a foreign/unattested listener fails closed; `/identity` distinguishes compatible vs incompatible resident runtime; closing a child releases only its lease; explicit shutdown revokes sessions, closes boundedly, and cleans owned artifacts; no credential/token/account identity appears in service definitions, logs, or diagnostics |
| AT-034 | Query the provider model intelligence registry (#67) | Exact access-provider identity, upstream model id, and model family are distinct; the same upstream id through two access providers stays separate and never satisfies cross-provider lookup; one aggregator exposes many families without parallel registries; compatibility state is typed and separate from raw capability support; discovery produces proposals without mutating trusted evidence; registry document revision changes are explicit and migration-covered |
| AT-036 | Refresh a provider catalogue into a propose-only drift report (#23 / BL-042) | A provider catalog source produces a normalized discovery snapshot without registry mutation access; identical trusted registry + identical snapshot yield a stable unchanged proposal on repeated runs; new/removed/model-family/reasoning/declared-capability drift each produce deterministic report entries; a large aggregator snapshot stays deterministic and never auto-activates every model; refresh cannot change trusted registry evidence, profile tier mappings, or `/v1/models` output; missing provider models are reported as drift with no silent substitute; proposal artifacts can reference #24 compatibility evidence but never treat skipped/unrun tests as a pass; `rly admin models refresh|proposals` surfaces proposals with a `trusted: false` marker without representing them as selectable/usable models |
| AT-037 | Inspect refresh errors, proposal output, and persisted artifacts (#23) | Upstream catalog errors are actionable and privacy-redacted; credentials, authorization headers, and account identity are absent from proposal/log/artifact output; malformed persisted artifacts fail closed rather than being trusted |

## Evidence rules

- Automated evidence records command, tested revision, result, and redacted artifact where needed.
- Live provider evidence is opt-in, date/version/model-specific, and never stores prompt/response or secrets.
- A skipped scenario is not passing evidence. Its owning requirement remains unverified unless the baseline explicitly excludes it.
- Narrative reports cannot substitute for a failing or absent executable gate.
