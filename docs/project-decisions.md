# Project Decisions

## Product identity

- Brand/product: `RLY` / `RLY Gateway`.
- Repository/package/CLI: `RLY-Gateway` / `rly-gateway` / `rly`.
- Local checkout and durable state root: `rly-gateway` / `~/.rly`.
- The first RLY start migrates a legacy `~/.agent-gateway` tree only when `~/.rly` is absent; two roots are an operator-resolved conflict.
- Development posture: private-first and public-ready.
- License: MIT, with per-module upstream provenance for copied or substantially adapted code.

## Runtime defaults

- TypeScript strict on Node.js active LTS.
- pnpm, Fastify, native fetch/Undici, Zod at external/config boundaries, Vitest.
- TOML launch configuration plus versioned SQLite control-plane metadata.
- Deterministic default loopback port `17871`.
- Foreground launcher lifecycle first; background service follows control-plane recovery evidence.

## Security and privacy

- Direct API credentials may use approved references. Project-owned OAuth credentials use a `0700` store with `0600` atomic files or an approved OS secret backend.
- Credential broker owns explicit import/login/refresh, single-flight, generation CAS, backup, and recovery.
- Managed bridges remain supported where they are more stable than project-owned OAuth.
- Diagnostics may include request ID, route/provider/model identifiers, capability/readiness state, timing, status, and version metadata.
- Diagnostics exclude prompts, responses, credentials, authorization headers, email, and account identity.

## Token counting

Routes declare one quality level: `upstream`, `exact-local`, `conservative-estimate`, or `unsupported`. Conservative estimates are allowed with a safety margin and visible readiness warning; they are never labeled exact.

## Provider sequencing

- Claude Code is the first harness; the currently observed compatibility target is `2.1.229`. It becomes a tested baseline only after the Claude Code E2E gate passes.
- Codex CLI is second; the currently observed provisional target is `0.147.0-alpha.6.5`. It becomes a tested baseline only after the Codex E2E gate passes.
- Direct Claude routes: OpenRouter first, DeepSeek second.
- Project-owned Codex OAuth through Claude Code is the first control-plane vertical slice.
- Account metadata, credential records, profiles, pools, health, and policy are first-class product concepts.
- Google Gemini/Code Assist OAuth and Google Antigravity are separate provider integrations.
- OpenCode Go follows the credential-broker and pool foundation.
- Alibaba Token Plan is deferred until after Claude MVP, local-only, feature-gated, and requires explicit terms acceptance.
- Codex runtime and Google Antigravity bridge follow Claude acceptance.
- ClinePass is an explicit interoperability adapter after the first OAuth/pool slice.
- First local UI increment is admin plus diagnostics: providers, accounts, pools, profiles, health/quota, audit, and last-N route traces. Secrets stay out of the browser.
- After the Phase 10 UI/fail-closed slice, provider breadth pauses. Next integration target is Codex OAuth and ClinePass through Claude Code. Claude subscription OAuth remains implemented as text-only and is parked in `BACKLOG.md` until stream/tools and an owner OAuth-vs-bridge decision exist.

## Non-goals for V1

Remote/multi-user administration, unbounded or post-stream failover, cost/prompt-derived routing, plugin marketplace, silent credential discovery, and persistent global Claude/Codex configuration.
