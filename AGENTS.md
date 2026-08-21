# Repository Guidelines

## Project Overview
RLY Gateway is a local, protocol-preserving gateway for Claude Code (Anthropic Messages) and Codex CLI (OpenAI Responses) through explicit provider/account-pool/model policies. Credentials and runtime stay on-device, listeners bind `127.0.0.1` only. Launch named profiles via `rly <profile>` (e.g. `rly codex`), route without flattening streaming/tools/reasoning, and manage via loopback Config UI + authenticated `/v1/*` management API.

## Architecture & Data Flow
```
CLI (rly) → launch session (frozen binding) → Fastify gateway :17871 → route → provider adapter → upstream
                 ↘ management API :17872 (CRUD providers/accounts/pools/profiles, policy revisions)
```

* **Composition root:** `src/runtime/owned-gateway.ts` wires `ControlPlaneStore` (SQLite), `CredentialBroker`, `RouteSelector`, Fastify gateway+management, `LaunchSessionRegistry`.
* **Launch session:** `src/profiles/sessions.ts` + `src/runtime/gateway-lifecycle.ts` — opaque token, frozen `profile→pool` binding per session (#J2), pinned model universe snapshot. New sessions only after profile edit.
* **Routing (two-stage):** `src/profiles/resolve-route.ts` — intent→tier→selection→reasoning→activate→decide→pool execute (`src/routing/pools/selector.ts` + `execute.ts`) → `invokeSelected`. Eligibility pure in `src/routing/eligibility/evaluate.ts`. Commitment boundary never rotates after first byte (`#121`).
* **Pools/Accounts:** `fill-first` / `round-robin` / `manual`, session affinity, quota `healthy→warning→unknown→exhausted` + cooldowns, env-presence check for `env:` handles.
* **Credentials:** `src/credentials/broker.ts` (prepare/bind/refresh, OAuth PKCE, generation locks) + `src/credentials/service.ts` (management ops). `provider + pool + account + credentialHandle` — no raw secrets in SQLite/Git.
* **Models:** `src/registry/model-registry.ts` trusted registry (#67) + `src/routing/model-projection/project.ts` (`claude-rly-*` projections). Fail-closed exact `(provider,model)` lookup.

## Key Directories
* `src/cli/` — `main.ts` entry, `init/install/update/uninstall/config/diagnostics` commands; `management-client.ts` helper.
* `src/runtime/` — `owned-gateway`, `gateway-server`, `gateway-lifecycle`, `resident-runtime`, `claude-overlay`; `bootstrap.ts` for `~/.rly/bootstrap/rly-gateway`.
* `src/routing/` — `pools/`, `eligibility/`, `model-decision/`, `model-projection/`, `model-intent/`; capability maps.
* `src/credentials/` — `broker`, `service`, `store`; OAuth + `env:` refs.
* `src/control-plane/` — `store.ts` (`node:sqlite`), `repository.ts`, `rows.ts`, `types.ts` (PolicyRevision).
* `src/management/` — Fastify admin `server.ts` + `collections.ts`/`dtos.ts` + UI `ui/`.
* `src/storage/` — `paths.ts` (`~/.rly` layout), `installation.ts` (pointer for custom `dataDirectory`), `private-files.ts`; `schema-v1.ts`.
* `src/service-manager/` — `LaunchAgent` (macOS) / `systemd-user` (Linux) adapters.
* `src/registry/`, `src/providers/`, `src/profiles/`, `src/canary/` — model evidence, dispatch, activation.
* `tests/` — `unit/` (~52), `lifecycle/` (25 inject tests), `routing/`, `contract/`, `privacy/` (13), `credentials/`, `browser/` (1 Playwright spec), `helpers/` + `fixtures/upstream/`.
* `scripts/` — `standalone/` (pack/build/verify), `release/` (sign/manifest/channel/sbom/provenance), `check-license.mjs`, `write-build-identity.mjs`.
* `.github/workflows/` — `ci.yml` (PR), `release-beta/stable.yml`, `standalone-artifacts.yml`.

## Development Commands
```bash
pnpm install --frozen-lockfile
cp gateway.config.example.toml gateway.config.toml
pnpm exec playwright install chromium

pnpm dev doctor                  # tsx src/cli/main.ts
pnpm lint                        # eslint .
pnpm typecheck                   # tsc --noEmit
pnpm test                        # vitest run (140 passed core)
pnpm test:browser                # playwright test (1 spec AT-031)
pnpm test:privacy                # vitest privacy + check-privacy.mjs (13 files)
pnpm build                       # write-build-identity.mjs + tsc -p tsconfig.build.json → dist/
pnpm verify                      # lint → typecheck → test → test:browser → build → test:privacy → test:release
pnpm dev -- --help               # CLI help via tsx
pnpm start -- --help             # node dist/cli/main.js
```

## Code Conventions & Common Patterns
* **Strict TS:** `ES2024`/`NodeNext`, `strict` + `exactOptionalPropertyTypes`; flat `eslint` with `typescript-eslint` strictTypeChecked. Top-level `import type` only — no `import("pkg").Type` inline.
* **Naming:** files kebab-case, factories `createX`, stores `ControlPlaneStore`, errors `*Error` with HTTP mapping, tests `*.test.ts` / `*.spec.ts` for browser.
* **Error handling:** typed domain errors (`ValidationError`, `VersionConflictError`, `CredentialUnreadyError`) → management HTTP codes; never throw raw `ENOENT` for foreign paths (return `{foreign:true}`).
* **Async:** `AsyncIterable` streams for SSE, promise-serialized `RouteSelector.select()`, `withLock` generation locks for credentials, bounded `shutdown()` with drain wait.
* **DI:** explicit options bags + factory overrides for test seams:
  ```ts
  export async function runInit(configPath: string, deps: InitDependencies = {}) {}
  // deps: loadConfig, createServiceManager, openControlPlane, waitForReadiness, home
  ```
* **State:** SQLite is source of truth; `PolicyRevision` versioned snapshots; `~/.rly/installation.json` pointer follows custom `dataDirectory` (see `src/storage/installation.ts:resolveControlPlaneDirectory`). Secrets never enter SQLite — `env:NAME` or handle only.

## Important Files
* `src/cli/main.ts` + `src/index.ts` — entry points (bin `rly` → `dist/cli/main.js`).
* `package.json` `bin.rly`, `engines.node>=24<25`, `packageManager pnpm@11.16.0`; `vitest.config.ts` (node env, `tests/**/*.test.ts`), `playwright.config.ts` (Chromium, 1 worker), `eslint.config.mjs`, `tsconfig.json`/`tsconfig.build.json`.
* `gateway.config.example.toml` — `schemaVersion 1`, gateway `127.0.0.1:17871/17872`, routes `primary/fast/reasoning`.
* `src/storage/paths.ts` + `installation.ts` — `~/.rly` layout + pointer; `src/runtime/owned-gateway.ts` composition.
* `scripts/standalone/pack.mjs` + `build-standalone.mjs` — deterministic tar/gzip, allowlist `bin/node`, identity `dist/rly-build.json`.
* `scripts/release/*` + `scripts/install.sh` — Ed25519-signed channel metadata, `scripts/check-license.mjs`.
* `.github/workflows/ci.yml` — PR gate `pnpm verify` on `macos-latest` with Node 24 + OpenSSL 3.

## Runtime/Tooling Preferences
* **Node 24** required (`engines >=24 <25`), **pnpm 11.16.0** only — `npm`/`yarn` not supported; lockfile `pnpm-lock.yaml` frozen in CI.
* Dev via `tsx` (`pnpm dev`), prod via `node dist/cli/main.js` or standalone tarball (`~/.rly/bootstrap/rly-gateway` + bundled `bin/node@24.19.0`).
* No Docker; install via `curl -fsSLO .../install.sh | sh -s -- --channel stable` (verifies signed metadata + Ed25519).
* Platform: macOS LaunchAgent / Linux `systemd --user` (no lingering/root service). Use `~/.rly` + `~/.local/bin/rly` only — never mutate `~/.claude` or Codex config.
* Standalone artifacts: `out/standalone/` per target (`linux-x64` stable, others experimental); release qualification on exact bytes is publication authority.

## Testing & QA
* **Frameworks:** Vitest 4 (node) + Playwright 1.62 (Chromium, `tests/browser` only, 30s timeout). No coverage tool (c8/Istanbul not configured); quality via layered suites + privacy gates.
* **Suites:**
  ```bash
  pnpm test:unit              # unit (cli, registry, installer)
  pnpm test:contract          # protocol fidelity (Anthropic/OpenAI) + provider contracts
  pnpm test:integration       # fake upstream chaos (needs OpenSSL 3 on macOS)
  pnpm test:lifecycle         # Fastify inject() wiring
  pnpm test:privacy           # secret-free invariants + repo scan
  pnpm test:browser           # AT-031 keyboard/a11y/secret-free DOM
  pnpm test:release           # supply-chain + package inventory + clean-install smoke
  ```
* **Helpers:** `tests/helpers/{codex,cline,compat,installer}-*`, `tests/routing/helpers.ts` (`createReadyPool`, `seedAccounts`), `tests/credentials/helpers.ts` (`fakeOauth`).
* **Fixtures:** `tests/fixtures/upstream/` golden bytes (#119) + `tests/fixtures/` fake clients (Layer B). Privacy: `scripts/check-privacy.mjs` forbids Bearer/JWT/private keys in fixtures.
* **CI:** `.github/workflows/ci.yml` runs full `pnpm verify` on `macos-latest`; PR title must be conventional-commit.
