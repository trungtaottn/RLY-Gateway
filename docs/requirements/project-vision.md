# Project Vision

## Vision

Give one owner a trustworthy local control plane for using Claude Code first, and later Codex CLI, across direct APIs and subscription-backed provider accounts without surrendering protocol fidelity, account control, privacy, or native-client recovery.

## Problem

Current workflows require separate tools for Claude Code provider switching, Codex subscription routing, ClinePass access, account pooling, credentials, quota state, and UI configuration. This fragments operational state, duplicates proxy processes, couples users to other projects' release choices, and makes routing or credential behavior difficult to audit.

## Product outcomes

- One locally owned provider/account/profile/pool system.
- Claude Code retains tools, hooks, permissions, skills, reasoning, streaming, and cancellation semantics.
- Credentials can be explicitly imported or authenticated, safely refreshed, reused, paused, revoked, and recovered.
- Account selection is deterministic, eligibility-aware, request-scoped, and explainable.
- Configuration and diagnostics are usable through CLI first and a secret-free local UI later.
- Codex CLI joins through OpenAI Responses without weakening the Claude boundary.
- A native client path remains available because normal operation does not persistently rewrite global client configuration.

## Stakeholders

| Stakeholder | Need |
| --- | --- |
| Product owner/operator | Own providers, accounts, policies, credentials, and release timing |
| Claude Code user | Preserve Claude interaction and tool behavior across providers |
| Codex CLI user | Use the same control plane through Responses semantics |
| Developer | Stable boundaries, source provenance, executable acceptance criteria |
| QA/security reviewer | Traceable requirements, deterministic failures, secret-safe evidence |
| Future public contributor | One public baseline without private development history or user data |

## Scope

V1 includes a local modular control/data plane, project-owned credential broker, Codex OAuth vertical slice, deterministic account pools, profiles/launcher UX, secret-free management API/UI, selected additional providers, Codex harness support, and private release hardening.

V1 excludes remote or multi-user administration, silent credential discovery, prompt-derived or unbounded automatic routing, post-output account rotation, a generic plugin marketplace, and persistent global Claude/Codex mutation.

## Success measures

- Supported Claude and Codex flows pass their protocol, tool, cancellation, concurrency, and no-global-mutation acceptance gates.
- Credential import/login/refresh/revoke/recovery and pool race/crash tests pass without secret leakage.
- Every route decision is traceable to a policy revision, capability result, account pseudonym, and credential generation.
- Every substantially reused module has verified license/provenance.
- A clean public release can be produced as one reviewed snapshot commit without publishing private development history.

## Assumptions and dependencies

- Initial deployment is a personal macOS workstation with loopback-only services.
- Provider behavior and subscription terms may change; readiness is evidence-dated and fail-closed.
- CCS, OpenCodeX, claude-proxy, and CLIProxy Plus are evidence/reuse candidates, not product authority.
- Project authority is maintained in the linked SPEC, ADRs, requirements, and roadmap.

## Risks

- OAuth/client-store drift can invalidate imported credentials.
- Incorrect retry or account rotation can duplicate tool effects.
- Provider terms may constrain subscription routing or pooling.
- Management UI can become a secret-exposure boundary if DTO discipline fails.
- Copied code can introduce hidden lifecycle, logging, or licensing obligations.
