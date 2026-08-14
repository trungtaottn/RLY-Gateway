# RLY Gateway Backlog

Items here are not committed V1 scope. Promotion requires evidence, owner approval, and an update to SPEC/roadmap/plan as appropriate.

GitHub board: [RLY Gateway Backlog](https://github.com/users/trungtaottn/projects/4) (private). Every repo issue and PR is added automatically. Status is `Backlog` when the issue has the `backlog` label, `Todo` for other open issues, `In Progress` for open PRs, and `Done` when closed or merged.

## Near-term candidates

- macOS Keychain backend as an alternative to project-owned credential files.
- Rich diagnostic bundle with an explicit metadata allowlist.
- Provider catalog refresh command that proposes, but never silently applies, registry changes.
- Compatibility canary for newly installed Claude Code and Codex CLI versions.
- Native/local exact tokenizer support where licensing and model parity are verified.

## Next focus (not started as a new V1 milestone until promoted)

Owner decision 2026-08-14: stop broadening providers. Next work is **Codex OAuth and ClinePass through Claude Code**. Claude subscription OAuth stays here until promoted.

### Codex OAuth → Claude Code

Already in tree: project-owned PKCE login, explicit Codex import, refresh CAS, revoke, `codex-oauth` adapter, selected-account route, `rly <profile>` / `run claude --profile`, opt-in live pool smoke (`RLY_LIVE_CODEX_OAUTH=1`). Phase 3 adds the Claude Code operator path.

| ID | Issue | Task | Acceptance |
| --- | --- | --- | --- |
| NX-001 | [#1](https://github.com/trungtaottn/RLY-Gateway/issues/1) | Operator recipe: create `codex` provider, login or import, pool, Claude profile named `codex`, `rly codex` | Done: README/CONTRIBUTING; no raw secrets; `--profile` and `--route` stay exclusive |
| NX-002 | [#2](https://github.com/trungtaottn/RLY-Gateway/issues/2) | Fake-upstream Claude Code E2E through Codex OAuth (not OpenRouter) | Done: `tests/e2e/claude-code/codex-oauth.e2e.test.ts` (gated `RLY_CLAUDE_E2E=1`; skipped ≠ pass) plus lifecycle helper/quota/sticky |
| NX-003 | [#3](https://github.com/trungtaottn/RLY-Gateway/issues/3) | Opt-in live smoke: Claude Code → gateway → Codex OAuth | Done: `tests/e2e/claude-code/codex-oauth-live.e2e.test.ts` (`RLY_LIVE_CODEX_OAUTH=1`; skipped ≠ pass) |
| NX-004 | [#4](https://github.com/trungtaottn/RLY-Gateway/issues/4) | Profile model roles for Codex models used as Claude helpers | Done: exact `(codex, gpt-5.4)` evidence; missing/cross-provider evidence fails closed |
| NX-005 | [#5](https://github.com/trungtaottn/RLY-Gateway/issues/5) | Status/quota/route-trace for a live Codex profile | Done: CLI prints pseudonym + quota class + decision reason only |

### ClinePass → Claude Code

Already in tree: explicit Cline import, `cline` credential provider, no Codex refresh, `O_NOFOLLOW` read, `ClineInteropAdapter` (needs `endpointPolicy`). Continuous shared-store write-back is **not** in this slice.

| ID | Issue | Task | Acceptance |
| --- | --- | --- | --- |
| NX-010 | [#6](https://github.com/trungtaottn/RLY-Gateway/issues/6) | Pin a redacted ClinePass source schema from a real `auth.json` shape | Done: `tests/fixtures/upstream/clinepass/auth-shape.json` (synthetic; tokens omitted) |
| NX-011 | [#7](https://github.com/trungtaottn/RLY-Gateway/issues/7) | Declare the ClinePass upstream endpoint policy | Done: create requires explicit loopback or HTTPS endpoint; protected ports rejected |
| NX-012 | [#8](https://github.com/trungtaottn/RLY-Gateway/issues/8) | Operator recipe: explicit preview+import with `providerId`, pool, Claude profile | Preview without `providerId` stays rejected; import does not write the Cline store |
| NX-013 | [#9](https://github.com/trungtaottn/RLY-Gateway/issues/9) | Fake-upstream Claude Code E2E through `cline-interop` | Text + tools; Cline failure does not touch Codex credential files |
| NX-014 | [#10](https://github.com/trungtaottn/RLY-Gateway/issues/10) | Opt-in live smoke: Claude Code → gateway → ClinePass | Gated env; skipped ≠ pass |
| NX-015 | [#11](https://github.com/trungtaottn/RLY-Gateway/issues/11) | Continuous Cline store lock/backup/restore | Separate opt-in later; default remains one-time read-only import |

## Deferred from Phase 10 (do not enable for Claude Code)

### Claude subscription OAuth

Code exists (`src/providers/oauth/claude/`, catalog `claude`) but is **text-only** and **not** the Claude Code integration path. Do not expose it as a Claude harness profile until the items below are done.

| ID | Issue | Task | Acceptance |
| --- | --- | --- | --- |
| BL-020 | [#12](https://github.com/trungtaottn/RLY-Gateway/issues/12) | Decide project-owned Anthropic OAuth client vs attested Claude subscription bridge | Written owner decision; no first-party Claude Code client impersonation |
| BL-021 | [#13](https://github.com/trungtaottn/RLY-Gateway/issues/13) | Stream + tools + thinking on the Anthropic protocol path | AT-021 subset through this adapter; catalog capabilities match |
| BL-022 | [#14](https://github.com/trungtaottn/RLY-Gateway/issues/14) | Fake + opt-in live Claude Code E2E | Same gates as NX-002/NX-003 |
| BL-023 | [#15](https://github.com/trungtaottn/RLY-Gateway/issues/15) | Document `RLY_CLAUDE_OAUTH_CLIENT_ID` only after BL-020 | Example config; no default client id in source |

### Other Phase 10 leftovers

Closed in the Phase 10 worktree: #16 README + skipped live smoke, #17 success probe + skipped live smoke, #18 no TOML routes without reviewed models, #19 Chromium AT-031 subset, #20 create-time catalog reject, #6 synthetic ClinePass shape, #7 explicit Cline endpoint policy.

Still next-focus, not Phase 10 close: Cline Claude Code E2E/live (#8–#10), continuous Cline store (#11), parked Claude OAuth (#12–#15). Live Gemini/Antigravity smokes remain opt-in; skipped ≠ pass.

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
