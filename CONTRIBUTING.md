# Contributing To RLY Gateway

Before work, follow [AGENTS.md](./AGENTS.md) and route the task through the [requirements pack](./docs/requirements/README.md). Requirement or behavior changes must preserve IDs, update RTM/acceptance evidence, and reconcile the owning authority before completion.

This repository is initially personal, but all changes should be reviewable and publishable without exposing private machine state.

## Before changing code

1. Route the task through the [requirements pack](./docs/requirements/README.md), [SPEC.md](./docs/SPEC.md), and relevant ADRs.
2. Check [TASKLIST.md](./docs/TASKLIST.md), RTM/acceptance IDs, and the active plan phase.
3. Confirm the work is committed scope; otherwise place it in [BACKLOG.md](./docs/BACKLOG.md).
4. Inspect current provider/protocol compatibility evidence.
5. Never paste or commit credentials, real prompts, responses, account identity, or private provider payloads.

## Development loop

```text
fixture or failing test
→ smallest contract-aligned implementation
→ focused test
→ shared type/lint/build gates
→ lifecycle/privacy gates when relevant
→ independent review
→ plan/tasklist sync
```

Protocol drift must begin with a redacted reproducing fixture. Provider changes must update capability evidence, fixture revision, verification date, and compatibility docs.

## Git workflow

- Handle one plan phase per isolated worktree and branch. That worktree may include every issue in the phase. See [AGENTS.md](./AGENTS.md) Issue delivery.
- Branch from latest `origin/dev` as `<type>/<phase>-<slug>`. Feature, fix, and chore work opens a PR into `dev`; Stable promotion uses a reviewed PR into `main` after the one-time public-baseline rules are satisfied.
- Keep commits small and use a Conventional Commit-compatible PR title; squash merge into `dev` uses that title as the release commit intent.
- Fill every required section in `.github/pull_request_template.md`. Thin or empty PR bodies are not reviewable.
- Do not commit directly to `dev` or `main`. Both branches require a reviewed PR and green `required-ci`; direct and force pushes are forbidden.
- Never rewrite or discard unrelated local work. Force-push, history rewrite, push/PR to `main`, and publish still need explicit owner authorization.
- Do not add an upstream remote merely because code was studied or adapted.
- Record copied or substantially adapted MIT code in `docs/provenance.md` and the adaptation matrix before commit. Retain the original notice in-file or in `docs/third-party-notices.md`.

## Safety rules

- Never signal a process based only on port occupancy.
- Never use existing protected ports `10100`, `8317`, or `17870` for this project.
- Never persist global Claude/Codex configuration in normal launch paths.
- Codex through Claude Code is a Claude harness profile named `codex` launched as `rly codex`. Follow the README operator recipe: `rly init` once, then `rly config` for the control plane — create the `codex` OAuth provider, login or explicit import (never paste tokens), pool, profile, then `rly codex`. `rly run codex` remains Codex CLI. `--profile` and `--route` stay exclusive.
- ClinePass through Claude Code is a Claude harness profile named `clinepass` launched as `rly clinepass`. Follow the README operator recipe: `rly init` once, then `rly config` — create the `cline` provider with an explicit `--endpoint`, preview+import with `--provider-id` (never paste tokens; import does not write the Cline store), pool, profile, then `rly clinepass`. Catalog id stays `cline`. Continuous Cline store lock/writeback is not default.
- `rly config` is the primary user-facing control plane after `rly init` (durable `~/.rly` resolution, resident-runtime recovery, secret-free status, local UI bootstrap, and focused provider/account/pool/profile shortcuts over the management API). `rly admin` stays the advanced/operator surface over the same endpoints; never add a second configuration database or a hand-edited-config workflow as the normal-user path.
- Credential import/interoperability may read another client store only when explicitly requested by the owner and governed by the credential broker contract.
- Never retry after response bytes or a tool event have been emitted.
- Live tests are opt-in and must not log real content.

## Distribution and packaging

- Standalone RLY-owned runtime artifacts are the PRIMARY production distribution (#35): `pnpm artifact:build` (or `node scripts/standalone/build-standalone.mjs --build --targets all`) produces deterministic `rly-<version>-<target>.tar.gz` packages (bundled pinned Node, compiled runtime, prod deps, licenses/notices, `rly.json`/`rly-build.json`/`rly-artifact.json`) under `out/` (gitignored) and `pnpm artifact:verify`/`scripts/standalone/verify-artifact.mjs` verifies allowlist/absence/identity/digest/smoke. Hermetic coverage lives in `tests/unit/standalone-artifact.test.ts` (runs in `pnpm test`).
- The signed release supply chain (#128) is published from the same `out/standalone` lineage: `pnpm release:publish` (`scripts/release/publish.mjs`) emits the canonical `rly-release.json` + per-target SBOMs + `rly-provenance.json` + Ed25519 `<tarball>.sig` signatures + signed `rly-channel-<channel>.json` metadata; `pnpm artifact:qualify` (`scripts/release/qualify.mjs`) runs exact-byte qualification (the publication authority) and `pnpm release:verify` (`scripts/release/verify-release.mjs`) verifies shape/identity/digest-binding/signatures/channel gates/immutability — exit non-zero on any failure. The signing private key is ONLY the repository secret `RLY_RELEASE_SIGNING_KEY` (never commit it; `node scripts/release/keygen.mjs --out-dir <dir>` regenerates a pair — commit only the public key). Hermetic coverage: `tests/unit/release-supply-chain.test.ts`; static supply-chain controls (action pinning, least privilege, no npm creds, no tracked keys, docs authority) are enforced by `scripts/check-release-supply-chain.mjs` in `pnpm test:release`.
- Never commit built artifacts, tarballs, Node bundles, signing private keys, or `out/` to git — scripts, config, manifests, and docs only. Local smoke builds go to the gitignored `out/` or a temp directory.
- The canonical version authority is `RLY_RELEASE_VERSION` → exact git tag → `package.json`; a build whose `dist/rly-build.json` version diverges from the resolved release version fails. npm/Homebrew secondary channels must consume the same canonical artifact lineage, never rebuild different bytes under the same build identity.

## Definition of done

- Acceptance criteria for the active phase are met.
- Focused and shared tests pass.
- No new lint, type, or build errors.
- Public/config/protocol contracts changed only intentionally and are documented.
- Privacy scan passes.
- Relevant docs and plan state reflect reality.
- Independent reviewer reports no critical blocker.

## Documentation ownership

| Change | Update |
| --- | --- |
| Product behavior or scope | Owning requirements document, `docs/SPEC.md`, and RTM |
| Current committed work | `docs/TASKLIST.md` and active plan |
| Uncommitted future idea | `docs/BACKLOG.md` |
| Milestone sequence | `docs/ROADMAP.md` |
| Durable architecture | `docs/ARCHITECTURE.md` and ADR when needed |
| Runtime/tool policy | `docs/TECH-STACK.md` |
| Provider/protocol compatibility | compatibility docs introduced by their implementation phase |
| Verified requirement | RTM evidence, Acceptance Test Cases if scenario changed, TASKLIST and active phase |

Do not duplicate detailed phase steps into evergreen docs.

## Unresolved questions

- None for bootstrap contributors.
