# Release governance

`dev` is the Beta lane and `main` is the Stable lane. Full validation is PR-only; trusted post-merge updates release without rerunning `pnpm verify`.

## Required GitHub configuration

Apply a branch-protection rule to both `dev` and `main` after the `required-ci` check has appeared on a PR:

- require pull requests before updating;
- require status check `required-ci`, strict/latest-head enabled;
- enforce for administrators;
- disable force pushes and deletion;
- do not configure a broad bypass actor or app.

`dev` exists and receives this rule now. `main` does not yet exist; do not create it merely for governance. Apply the identical rule immediately after the authorized clean public-baseline bootstrap creates it.

## Merge policy

Use Conventional Commit-compatible PR titles. Squash merge is preferred for feature/fix/chore PRs into `dev`. The first public baseline must not connect private history; after it exists, `dev` → `main` promotions preserve ancestry for post-Stable alignment.
