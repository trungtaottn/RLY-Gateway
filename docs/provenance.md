# Upstream Provenance

Agent Gateway has a clean Git history. Architecture research may influence
implementation, but copied or substantially adapted code must be recorded here
before commit.

Machine-readable pins live in [`provenance/artifacts.json`](./provenance/artifacts.json).
The planned reuse map lives in [`source-adaptation-matrix.md`](./source-adaptation-matrix.md)
and [`provenance/adaptation-matrix.json`](./provenance/adaptation-matrix.json).
Required copyright texts live in [`third-party-notices.md`](./third-party-notices.md).

No source file has been copied into this repository. The current implementation
is original code derived from accepted project contracts.

Phase 07 independently implemented credential persistence, PKCE login, refresh
compare-and-swap, and the Codex OAuth adapter. The work follows the already
pinned `adapted` rows `opencodex-credential-cas`, `opencodex-oauth-pkce`, and
`claude-proxy-codex-oauth` without copying source text. Verification owner:
credentials / providers. Notices remain in `docs/third-party-notices.md`.

Phase 08 independently implemented eligibility-first account selection,
deterministic pool strategies, EffectiveRoute binding, outcome/cooldown
persistence, and bounded pre-output rotation. The work follows the already
pinned `adapted` rows `opencodex-eligibility-pools` and
`opencodex-health-outcome` without copying source text. Verification owner:
routing. Notices remain in `docs/third-party-notices.md`.

Phase 09 independently implemented profile activation, Claude helper-role
mapping, transient target detection, lease-scoped launch tokens, pool-mounted
Anthropic resolve, and secret-free quota/route-trace diagnostics. The work
follows the already pinned `adapted` rows `ccs-profile-target`,
`ccs-alias-normalization`, `ccs-account-quota-ux`, and
`claude-proxy-helper-map` without copying source text. Verification owner:
profiles. Notices remain in `docs/third-party-notices.md`.

## Frozen artifacts (2026-08-13)

A repository revision may not be treated as the package source unless contents
or release metadata prove correspondence. Installed package git HEADs were
reconciled against GitHub tags; both CCS and OpenCodeX research revisions are
later `main` commits and are not the copy authority.

| Artifact | Pin | License | Copy? |
| --- | --- | --- | --- |
| `@kaitranntt/ccs@8.9.0` npm tarball | SHA-256 `80af985cb5f454e95525fa14a9f9a71e4fe35038913b98d366f83a2e3b203fbf`; tag `v8.9.0` / `f8a9518b1799fc034249fd4e4e39f5aa2c81186c` | MIT, Copyright (c) 2025 CCS Contributors | Yes, after a matrix row |
| `@bitkyc08/opencodex@2.11.1` npm tarball | SHA-256 `a302133d93ae355d0d8015741d3696174facefbba21eb2b5a4bff35e6d2f5f22`; tag `v2.11.1` / `121f1ad929dc6da3356c06f5192f2f97f7a5dde5` | MIT, Copyright (c) 2026 opencodex contributors | Yes, after a matrix row |
| `aryan877/claude-proxy` git archive | commit `6c21df813cd0cb327ff697543b27ad645d0a2e57`; archive SHA-256 `38435879bbc769d0a22e071c1c4413f209403ecdcdea71941b8419effbf7a4e6` | MIT, Copyright (c) 2025 Joseph Stephenson-Mouzo | Yes, clean commit only |
| CLIProxyAPIPlus `v7.2.127-3` official Darwin arm64 tarball | tarball SHA-256 `69d302ceda68ae6b9c565bb3f9d2292a14b28978b877634c0e386acb86cd233c`; binary SHA-256 `6f10951235db07ee906ad2056a941fd01bcaa0d2ba3ee894a1d2397efc286828`; commit `4823235a6c3a1566b7acd088f1d752c898251deb` | MIT, independently proven; Copyright (c) 2025-2005.9 Luis Pater; Copyright (c) 2025.9-present Router-For.ME | No source copy |
| CLIProxyAPI `v7.2.129` official Darwin arm64 tarball | tarball SHA-256 `66c003f1eae50c9586b02fa6a6f76959241c13d242883ba400eafeab98fefea0`; binary SHA-256 `0c7f420959958bb685bac84be9f8aa3a8063de20987ec83217814571919fee59`; commit `934da2379d6272a704953a02322b666b2a2efa3e` | MIT, same notice as Plus | No source copy |

Research revisions retained as historical study pins only:

- CCS study commit `febdcdbbf4c1c5719082cc6dadf6c1b542c2f017` (later than `v8.9.0`)
- OpenCodeX study commit `7bdc8f86cd546b90f6aec6472d44a7ed75a979cf` (later than `v2.11.1`)

## CLIProxy Plus proof

CCS MIT does not cover the bundled proxy. Independent evidence:

1. CCS `8.9.0` names `kaitranntt/CLIProxyAPIPlus` as the Plus backend and
   `router-for-me/CLIProxyAPI` as the original backend.
2. The Plus repository and the official `v7.2.127-3` tarball both ship an MIT
   LICENSE with the Router-For.ME / Luis Pater copyright.
3. The official tarball SHA-256 and the extracted binary SHA-256 are recorded
   above. The locally installed Plus executable matches the official binary
   hash; it was used only as a version/identity check.
4. `go version -m` reports `v7.2.127-3+dirty`. The release binary is therefore
   not a clean source tree.

Decision: license is proven; source copy and vendoring are blocked. The binary
may later be an attested managed bridge, never a process this project starts on
ports `10100`, `8317`, or `17870`.

## Recording an adaptation

Before a later phase copies or substantially adapts a module, add a matrix row
with all of:

- artifact id from `artifacts.json`
- exact source path inside that artifact
- destination path
- classification: `copied`, `adapted`, `oracle-only`, or `rejected`
- verification owner
- required copyright/license notice
- kernel-invariant review note

Retain the original MIT notice in-file or in `docs/third-party-notices.md`.

## Third-party notice strategy

- Notices for frozen artifacts are stored in `docs/third-party-notices.md`.
- A later substantial copy must keep the original copyright and permission
  text. Prefer an in-file header for a copied source file; otherwise add a
  destination row to the notices file in the same commit.
- Behavioral reuse without substantial source copy is oracle-only and does not
  require an in-file notice.
- Rejected rows never enter `src/`.
- Dependency and bundled-asset license auditing remains a release gate via
  `pnpm-lock.yaml`. This freeze does not vendor third-party binaries.

## Rejected patterns

These behaviors are recorded so later phases cannot import them from study
sources:

| Pattern | Typical source | Response |
| --- | --- | --- |
| Kill-by-port | claude-proxy `killPortOccupant`; OpenCodeX `port-reclaim.ts` | Fail closed on a foreign listener |
| Silent import | OpenCodeX local token detect; claude-proxy default store reads | Explicit, read-only import only |
| Default shared-store writes | claude-proxy Codex/Cline adapters | Project-owned store is canonical |
| Post-output retry | claude-proxy Gemini account fallback | No rotation after first byte or tool event |

## Sanitized fixtures

Compatibility fixtures live in `tests/fixtures/upstream/`. They contain only
synthetic shapes. They must not contain credentials, identity, prompts,
responses, or live machine paths.

## Dependency provenance

Package dependencies are pinned through `pnpm-lock.yaml`. Dependency and
bundled-asset license auditing is required before release.
