# Agent Gateway Backlog

Items here are not committed V1 scope. Promotion requires evidence, owner approval, and an update to SPEC/roadmap/plan as appropriate.

## Near-term candidates

- macOS Keychain backend as an alternative to project-owned credential files.
- Rich diagnostic bundle with an explicit metadata allowlist.
- Provider catalog refresh command that proposes, but never silently applies, registry changes.
- Compatibility canary for newly installed Claude Code and Codex CLI versions.
- Native/local exact tokenizer support where licensing and model parity are verified.

## Next focus (not started as a new V1 milestone until promoted)

Owner decision 2026-08-14: stop broadening providers. Next work is **Codex OAuth and ClinePass through Claude Code**. Claude subscription OAuth stays here until promoted.

### Codex OAuth → Claude Code

Already in tree: project-owned PKCE login, explicit Codex import, refresh CAS, revoke, `codex-oauth` adapter, selected-account route, `run claude --profile`, opt-in live pool smoke (`AGENT_GATEWAY_LIVE_CODEX_OAUTH=1`). Missing is a repeatable Claude Code path.

| ID | Task | Acceptance |
| --- | --- | --- |
| NX-001 | Operator recipe: create `codex` provider, login or import, pool, Claude profile, `run claude --profile` | README/CONTRIBUTING steps; no raw secrets; `--profile` and `--route` stay exclusive |
| NX-002 | Fake-upstream Claude Code E2E through Codex OAuth (not OpenRouter) | Text + tools + helper map + cancel; no global Claude/Codex config mutation |
| NX-003 | Opt-in live smoke: Claude Code → gateway → Codex OAuth | Gated env; secret-free evidence only; skipped ≠ pass |
| NX-004 | Profile model roles for Codex models used as Claude helpers | Capability preflight rejects unsupported required tools/images; no silent remap |
| NX-005 | Status/quota/route-trace for a live Codex profile | Pseudonym + quota class + decision reason only |

### ClinePass → Claude Code

Already in tree: explicit Cline import, `cline` credential provider, no Codex refresh, `O_NOFOLLOW` read, `ClineInteropAdapter` (needs `endpointPolicy`). Continuous shared-store write-back is **not** in this slice.

| ID | Task | Acceptance |
| --- | --- | --- |
| NX-010 | Pin a redacted ClinePass source schema from a real `auth.json` shape | Fixture synthetic only; provenance row if we adapt parser details |
| NX-011 | Declare the ClinePass upstream endpoint policy | Documented loopback or HTTPS endpoint; never ports `10100`/`8317`/`17870` |
| NX-012 | Operator recipe: explicit preview+import with `providerId`, pool, Claude profile | Preview without `providerId` stays rejected; import does not write the Cline store |
| NX-013 | Fake-upstream Claude Code E2E through `cline-interop` | Text + tools; Cline failure does not touch Codex credential files |
| NX-014 | Opt-in live smoke: Claude Code → gateway → ClinePass | Gated env; skipped ≠ pass |
| NX-015 | Continuous Cline store lock/backup/restore | Separate opt-in later; default remains one-time read-only import |

## Deferred from Phase 10 (do not enable for Claude Code)

### Claude subscription OAuth

Code exists (`src/providers/oauth/claude/`, catalog `claude`) but is **text-only** and **not** the Claude Code integration path. Do not expose it as a Claude harness profile until the items below are done.

| ID | Task | Acceptance |
| --- | --- | --- |
| BL-020 | Decide project-owned Anthropic OAuth client vs attested Claude subscription bridge | Written owner decision; no first-party Claude Code client impersonation |
| BL-021 | Stream + tools + thinking on the Anthropic protocol path | AT-021 subset through this adapter; catalog capabilities match |
| BL-022 | Fake + opt-in live Claude Code E2E | Same gates as NX-002/NX-003 |
| BL-023 | Document `AGENT_GATEWAY_CLAUDE_OAUTH_CLIENT_ID` only after BL-020 | Example config; no default client id in source |

### Other Phase 10 leftovers

- Gemini project-owned OAuth live smoke and README for `AGENT_GATEWAY_GEMINI_OAUTH_CLIENT_ID`.
- Antigravity attested-bridge success-path identity probe + live opt-in.
- OpenCode Go / Alibaba: reviewed model evidence before TOML routes; Alibaba stays terms-gated.
- Real-browser management UI (keyboard, 375/1024) for AT-031; current evidence is HTML/CSS + inject tests.
- Reject uncatalogued provider names at create time (invoke already fail-closed).

## Provider expansion

- Additional providers beyond the committed Codex OAuth, Gemini, Cline, Claude, OpenCode Go, Alibaba, and bridge sequence.
- Anthropic API direct adapter.
- OpenAI API-key direct adapter separate from Codex subscription bridge.
- Gemini API direct adapter separate from Antigravity subscription bridge.
- Z.AI/GLM coding plan.
- Additional coding plans only after terms and protocol capability review.

## Routing evolution

- Ordered manual failover after duplicate-tool and retry safety are proven.
- Cost, latency, or capability policy routing only with deterministic decision traces.

## Operations and distribution

- Optional macOS launchd service after foreground ownership is stable.
- Linux service support.
- Signed package or standalone distribution.
- Remote TLS bridge support with explicit trust configuration.

## Explicitly rejected until new evidence

- Prompt-content model routing.
- Silent provider/model substitution.
- Blind port-owner termination.
- Silent credential discovery/import from client storage.
- Automatic OAuth client impersonation.
- Default logging of prompts or responses.

## Promotion checklist

Before moving an item to `TASKLIST.md`:

1. State the user outcome and acceptance criteria.
2. Identify security, terms, protocol, and lifecycle boundaries.
3. Add or update an ADR if architecture changes.
4. Update `SPEC.md` and `ROADMAP.md` if release scope changes.
5. Create an executable plan phase with tests and rollback.

## Unresolved questions

- Exact ClinePass upstream URL and whether any request needs a Cline-specific header besides the imported bearer.
- Whether the next Codex Claude Code E2E uses the existing opt-in live handle or a new profile-only recipe.
