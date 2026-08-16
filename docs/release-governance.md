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

## Standalone artifact distribution (#35)

- Standalone RLY-owned runtime artifacts are the PRIMARY production distribution: self-contained `rly-<version>-<target>.tar.gz` packages (bundled pinned Node runtime, compiled runtime, bundled prod deps, licenses/notices, `rly.json`/`rly-build.json`/`rly-artifact.json`) built by `scripts/standalone/build-standalone.mjs` from a clean compiled tree.
- The artifact build matrix runs on GitHub Release publication (`.github/workflows/standalone-artifacts.yml`, `release: published` or `workflow_dispatch` with an explicit `release-version` input). The release tag is the canonical version input (`RLY_RELEASE_VERSION`), so package.json/tag/runtime identity never diverge; a split identity fails the build.
- Every artifact is verified (positive allowlist + absence/secret scans, identity consistency across `rly-build.json`/`rly.json`/`rly-artifact.json`, content-addressed digest recompute) and smoke-tested (`rly --version` from the unpacked artifact) for every SUPPORTED CI target (linux-x64). Experimental targets (darwin-arm64, darwin-x64, linux-arm64) are built + verified; their unprovisioned smoke is explicitly skipped, never reported as passed.
- Tarballs + sha256 + `artifacts.json` manifest are uploaded and attached to the GitHub Release. Release signing/SBOM (#128) and installer/updater UX (#129) are separate tracks; `rly-artifact.json` is the SBOM input. npm/Homebrew secondary channels must consume the same canonical artifact lineage.
- Never commit built artifacts or `out/` to git.
