# Agent Working Contract

## Sync from `dev` before every cook, task, or phase

This is mandatory. Do it before scouting, planning, or writing code.

Every cook, every task, and every plan phase starts from current `origin/dev`. A stale worktree or branch is not an allowed starting point.

1. `git fetch origin`.
2. New cook, task, or phase: create an isolated worktree and branch from latest `origin/dev`. Do not implement in the primary `dev` checkout.
3. Existing worktree or branch: merge or rebase latest `origin/dev` into this branch so this worktree contains the newest `dev` code. Do not start until that sync succeeds.
4. Confirm this checkout contains `origin/dev` (`git merge-base --is-ancestor origin/dev HEAD`). If it does not, stop and sync before continuing.
5. If `origin/dev` moved during a long cook, sync again before opening the PR.

Use the installed worktree helper when available. Otherwise create from latest `origin/dev`:

```text
git fetch origin
git worktree add -b <type>/<phase>-<slug> <worktree-path> origin/dev
```

On an existing branch in its worktree:

```text
git fetch origin
git merge --ff-only origin/dev
```

If a fast-forward is not possible, rebase this branch onto `origin/dev` only when the branch is not shared. Do not force-push a shared branch.

## Read before work

- Any task: read `docs/requirements/README.md`, then the documents it routes for the task.
- Scope/product change: read Project Vision, BRD, SPEC, project decisions, and affected ADRs before implementation.
- System/architecture/security change: read SRS, ARCHITECTURE, SECURITY, and affected ADRs.
- Feature/provider work: read FRS, use cases, user stories, RTM, Acceptance Test Cases Catalogue, provenance, TASKLIST, and the active local phase.
- Bug fix: trace observed and expected behavior to FR/SR/AT IDs; never change a business rule silently.
- Test/review: start from RTM and Acceptance Test Cases IDs; narrative plan status is not passing evidence.

## Authority precedence

1. Explicit current owner decision.
2. `docs/SPEC.md`, BRD/SRS/FRS, and accepted ADRs within their owning domains.
3. `docs/ARCHITECTURE.md`, `SECURITY.md`, and project decisions.
4. RTM and Acceptance Test Cases Catalogue.
5. TASKLIST and active local plan for delivery state.
6. Research, reports, and upstream source as evidence only.

If same-level authorities conflict, stop implementation and reconcile the owning documents first.

## Requirement and documentation completion

- Preserve stable requirement IDs. Mark replacements `Superseded`; never renumber existing IDs.
- Every approved Must requirement needs RTM coverage and a named acceptance scenario.
- After behavior changes, update the smallest owning requirement/ADR plus RTM and acceptance evidence in the same work.
- After verified implementation, update TASKLIST and active phase with actual commands/results. A skipped or unavailable gate is not passed.
- Put unapproved ideas in `docs/BACKLOG.md`; do not silently expand V1.
- Record substantial upstream adaptations in `docs/provenance.md` before commit: exact revision/hash, source/destination paths, license/notice, classification, and verification owner.

## Engineering and safety

- Use Node 24, pnpm 11.16, strict TypeScript/ES modules, and existing package scripts.
- Run focused tests first. Before review, run `pnpm verify` and `git diff --check`.
- Protocol changes require redacted golden fixtures; lifecycle changes require ownership/race tests; credential/pool/management changes require privacy, concurrency, crash, and recovery tests.
- Never put real credentials, tokens, account identity, prompts, responses, or tool arguments in source, fixtures, snapshots, docs, logs, or reports.
- Never signal a process from port occupancy alone. Ports `10100`, `8317`, and `17870` and their owners are outside this project's control.
- Never persistently mutate global Claude/Codex configuration during normal launch flows.
- Credential import is explicit and read-only by default. Project-owned secret persistence belongs only to the credential broker.
- Eligibility precedes pool strategy; no retry/account rotation after the first response byte or tool event.

## Issue delivery

Handle one active plan phase per worktree, branch, and pull request. A phase worktree may close multiple GitHub issues that belong to that phase.

1. Sync this worktree or branch from latest `origin/dev` using **Sync from `dev` before every cook, task, or phase**.
2. Read the phase file, its issues, and the documents this contract routes for that work.
3. Branch name: `<type>/<phase>-<slug>` (example: `feat/10-ui-and-provider-expansion`). Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.
4. Keep the worktree scoped to that phase. A new phase gets another worktree. Do not start the next phase in the same worktree.
5. Open one PR into `dev`, never `main`. The PR body must list every issue: `Closes #<n>` when that issue is fully done, otherwise `Refs #<n>`.
6. After the PR merges, remove the worktree and the local branch.

Do not mix phases, commit on `dev` directly, or leave abandoned worktrees.

## Pull requests into `dev`

A PR to `dev` for the issue owned by the current worktree is authorized by this contract. Still require explicit owner authorization for: push or PR to `main`, force-push of a shared branch, history rewrite, publish, or adding remotes.

Every PR body must fill `.github/pull_request_template.md`. Do not open a PR with an empty or one-line body. Required content:

- **Summary:** user-visible outcome and why the issue needs it.
- **Issue link:** `Closes #<n>` or `Refs #<n>`.
- **Changes:** what landed, grouped by concern, with owning paths.
- **Requirements:** FR/SR/AT IDs touched, or `none` after checking the requirements pack.
- **Testing and evidence:** exact commands and closing results. A skipped or unavailable gate is not a pass.
- **Security and privacy:** secret-free confirmation when credentials, sessions, logs, fixtures, or redaction paths changed.
- **Breaking changes / migration:** or `none` after checking public contracts.
- **Out of scope / follow-ups:** leftover work and the issue that owns it.
- **Review notes:** risky spots and how to verify them.

Do not merge your own PR unless the owner asked. Do not commit `LICENSE` copyright flips, credentials, databases, logs, runtime state, user paths, or private fixtures.

## Git and release lanes

- `dev` is the Beta lane and `main` is the Stable lane. Both accept normal changes only through PRs with the required `required-ci` check green; direct and force pushes are forbidden.
- Full `pnpm verify` runs only on PRs targeting `dev` or `main`. A trusted post-merge branch update performs release responsibilities only; it must not rerun the full suite.
- Feature/fix/chore branches merge into `dev` with a Conventional Commit-compatible PR title; squash merge is preferred so that title is the release commit message.
- The future first public `main` baseline is a one-time clean-snapshot operation that must not expose historical private `dev` commits. After that bootstrap, normal `dev` → `main` promotion preserves ancestry for release alignment.
- `plans/` remains local-only. Public source and durable docs are tracked; credentials, databases, logs, runtime state, user paths, and private fixtures are never tracked.
