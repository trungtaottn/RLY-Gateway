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
- Tarballs + sha256 + `artifacts.json` manifest are uploaded and attached to the GitHub Release; the signed release supply chain (next section) is attached in the same publish. npm/Homebrew secondary channels must consume the same canonical artifact lineage.
- Never commit built artifacts or `out/` to git.

## Release supply chain (#128) — exact-byte qualification is the publication authority

A release is promoted only on evidence produced by installing and exercising the EXACT artifact digest that is subsequently published — never a rebuilt equivalent, never a version label. The release supply chain (`scripts/release/`) turns the #35 artifact lineage into authenticated, traceable, qualification-tested release bytes:

- **Pipeline (in `.github/workflows/standalone-artifacts.yml`)**: build matrix → verify every artifact (allowlist/identity/digest/smoke) → QUALIFY the exact unpacked bytes (`scripts/release/qualify.mjs`, writes `rly-qualification.json`) → PUBLISH the signed supply chain (`scripts/release/publish.mjs`: canonical `rly-release.json` + per-target `.sbom.json` + `rly-provenance.json` + per-target `<tarball>.sig` + signed `rly-channel-<channel>.json`, all with `.sig` files) → VERIFY (`scripts/release/verify-release.mjs`, exit non-zero on any failure) → upload + attach to the GitHub Release.
- **Canonical release manifest** (`rly-release.json`) binds product version, release channel, source commit, build ID, every supported target, artifact filename/size/sha256/content-addressed digest, bundled runtime version, state/protocol compatibility, and required signatures/attestations — consistent with the #94 exact build identity; a manifest whose identity diverges from the packaged `rly-build.json` fails.
- **SBOM + provenance** are generated from the ACTUAL packaged bytes per artifact and reference the exact artifact digest (sibling assets, TUF-style separation of metadata from artifacts; never embedded in the tarball).
- **Platform authenticity**: macOS production artifacts must pass the documented code-signing/notarization/stapling verification gate before stable promotion; Linux uses the per-artifact Ed25519 signature + release manifest trust chain. A missing required platform signature BLOCKS promotion for that target.
- **Signing key discipline**: Ed25519; the PRIVATE key is ONLY the repository secret `RLY_RELEASE_SIGNING_KEY` (referenced as `env:RLY_RELEASE_SIGNING_KEY` in the workflow, never inline); the PUBLIC key is committed at `scripts/release/signing-public-key.pem` (fingerprint `9bc727b2a37d964b828399a75e7119f00c0037e1c7eff77568235b3a88699b3d`). If the key is ever rotated: run `node scripts/release/keygen.mjs --out-dir <dir>`, commit only `signing-public-key.pem`, install the private key as the secret, and update this fingerprint.
- **Signed channel metadata** (`rly-channel-<channel>.json` + `.sig`): maps beta/stable to exact release/build/artifact digests with explicit rollback (monotonic `version` counter; a lower version than the highest observed is refused), staleness (`updatedAt` + `staleness.maxAgeDays`, default 30; stale metadata is refused), and freeze (explicit `freeze.frozen` marker blocks activation beyond the frozen snapshot). The updater verifies the signature and never trusts a mutable GitHub `latest` target alone.
- **Exact-byte qualification matrix**: clean install, `rly --version`/build identity, permissions, platform signing, runtime readiness (doctor ok), update handoff contract, `rly init`/service registration, uninstall (self-containment). Gates are host-aware — a target the runner cannot execute is recorded `skipped` with a reason, never `passed`; `skipped`/`not-run` is never passing evidence. A target without full qualification evidence is NOT stable-qualified.
- **Beta vs stable gates (machine-readable)**: beta may publish with documented experimental qualification gaps (`experimental-gaps` recorded in `rly-qualification.json` and the channel metadata); stable requires `qualified` status for every advertised target plus all authenticity/compatibility/privacy/Wave-4-integration gates. Beta evidence can never masquerade as stable qualification. Today `linux-x64` reaches `experimental-gaps` on the repository runner (service registration requires a provisioned host); stable promotion additionally requires qualification evidence from a provisioned Linux host, and darwin targets additionally require a provisioned macOS host with signing/notarization.
- **Release immutability**: published bytes/digests are never silently replaced under the same release identity — republishing the same version with different digests fails (`assertReleaseImmutable`) and byte replacement of published assets is detected against the signed metadata (`detectAssetReplacement`). Because GitHub release assets are mutable by default, the signed metadata + build identity make replacement detectable and unacceptable.
- **Workflow hardening**: release-critical third-party Actions are pinned to reviewed immutable commit SHAs; release workflows use least-required `GITHUB_TOKEN`/release permissions and never configure npm credentials (npm is not the primary channel). `scripts/check-release-supply-chain.mjs` enforces these statically as part of the release gate (`pnpm test:release`).
- **Privacy/public boundary**: manifests, SBOMs, provenance, channel metadata, signatures, and qualification records contain public build metadata only — no credentials, tokens, local state, private source-history content, prompts, responses, or account identity.
