# Claude Code Working Contract

Follow [AGENTS.md](./AGENTS.md) as the repository working contract. Before any cook, task, or phase, fetch and sync latest `origin/dev` into this worktree or branch. Handle one plan phase per worktree (multiple issues in that phase are allowed) and open the PR into `dev`. Before changing behavior, use its task routing to read the owning BA requirements, SPEC/ADR, RTM, Acceptance Test Cases Catalogue, TASKLIST, and active local plan phase.

`dev` and `main` are protected PR-only Beta and Stable lanes. Full validation runs on the PR; trusted post-merge updates perform release work only. The first future public `main` baseline remains a one-time clean snapshot, after which normal release ancestry is preserved.

Claude-specific reminders:

- Keep global Claude configuration unchanged; launch settings are transient.
- Preserve Anthropic Messages tools, reasoning, streaming, usage, stop, helper mapping, cancellation, and concurrency contracts.
- Never invoke a provider before capability and request-time account eligibility checks pass.
- Never retry or rotate accounts after the first response byte or tool event.
