# Upstream Provenance

Agent Gateway has a clean Git history. Architecture research may influence implementation, but copied or substantially adapted code must be recorded here before commit.

| Source | Research revision | License | Current use |
| --- | --- | --- | --- |
| `lidge-jun/opencodex` | `7bdc8f86cd546b90f6aec6472d44a7ed75a979cf` | MIT | Architectural study: protocol normalization, route trace, lifecycle attestation |
| `kaitranntt/ccs` | `febdcdbbf4c1c5719082cc6dadf6c1b542c2f017` | MIT | Architectural study: target/profile separation, transient launch, bridge boundary |
| `aryan877/claude-proxy` | `6c21df813cd0cb327ff697543b27ad645d0a2e57` | MIT | Behavioral study: Claude Code gateway and launcher prototype |

No source file has been copied into the foundation. The current implementation is original code derived from accepted project contracts.

The active source-freeze phase must reconcile these research revisions with the exact installed packages inspected on 2026-08-13: CCS `8.9.0`, OpenCodeX `2.11.1`, and claude-proxy commit `6c21df813cd0cb327ff697543b27ad645d0a2e57`. A repository revision may not be treated as the package source unless contents or release metadata prove correspondence; otherwise record the npm tarball hash as an independent artifact.

CLIProxy Plus is a distinct bundled executable. Its repository, exact source revision/artifact hash, license, and copyright notice must be proven independently before copying any implementation from it.

## Recording an adaptation

Add source URL or artifact, exact revision/hash, original file/module, destination file/module, copied/adapted/reimplemented classification, adaptation notes, verification owner, and required copyright/license notice.

## Dependency provenance

Package dependencies are pinned through `pnpm-lock.yaml`. Dependency and bundled-asset license auditing is required before release.
