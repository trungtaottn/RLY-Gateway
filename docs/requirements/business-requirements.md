# Business Requirements Document

## Business objective

Replace a fragmented set of provider-specific proxy tools with one owner-controlled local product that makes multiple provider accounts usable through preferred coding harnesses while remaining maintainable and safe to publish.

## Business requirements

| ID | Requirement | Priority | Success evidence |
| --- | --- | --- | --- |
| BR-001 | The owner shall operate Claude Code through multiple accepted provider types from one product. | Must | Approved provider profile completes Claude acceptance |
| BR-002 | The product shall centralize provider, account, credential, profile, pool, health, and policy administration. | Must | Management contract and account/pool workflow acceptance |
| BR-003 | The owner shall retain control of credential import, login, refresh, pause, revoke, backup, and recovery. | Must | Credential lifecycle Acceptance Test Cases pass |
| BR-004 | The product shall reuse proven MIT implementations where beneficial without inheriting unverified behavior or provenance. | Must | Source adaptation matrix and notices accepted |
| BR-005 | Account selection shall be deterministic, eligibility-aware, explainable, and safe for tool-producing streams. | Must | Pool invariants and decision trace verified |
| BR-006 | Claude Code shall remain the first-class harness; Codex CLI shall use the same control plane through its native protocol boundary. | Must | Both harness acceptance suites pass |
| BR-007 | Users shall configure and diagnose the system through CLI, followed by a local secret-free UI. | Must | CLI and UI use the same management contract |
| BR-008 | Normal operation shall not require persistent global Claude/Codex configuration mutation or termination of foreign processes. | Must | Hash/process/port invariants pass |
| BR-009 | The product shall protect credentials, account identity, prompts, responses, and tool arguments from default logs, UI, audit, fixtures, and release artifacts. | Must | Privacy and secret scans pass |
| BR-010 | Provider integrations shall be explicitly terms-gated and evidence-dated. | Must | Terms revision and readiness block unaccepted/stale routes |
| BR-011 | Development history and local artifacts shall remain private when producing the first public release. | Must | One-snapshot public PR procedure verified |
| BR-012 | The system shall remain recoverable after credential, database, process, or migration interruption. | Must | Recovery and clean-install gates pass |

## Business rules

| ID | Rule |
| --- | --- |
| BR-R01 | A credential existing on disk does not imply terms acceptance or route readiness. |
| BR-R02 | Only the owner or a future explicitly authorized administrator may import or authenticate an account. |
| BR-R03 | One request binds one account pseudonym and credential generation. |
| BR-R04 | Account rotation is forbidden after the first response byte or tool event. |
| BR-R05 | An unverified or incompatible provider/model is unavailable, not silently substituted. |
| BR-R06 | Public snapshots contain source and public docs only; local plans and user-owned runtime data remain excluded. |

## Scope exclusions

- Remote/LAN or multi-user control plane.
- Credential resale, sharing between unrelated users, or usage-limit evasion.
- Prompt-content routing or generic provider marketplace.
- Automatic port selection and kill-by-port cleanup.
- Claims of forensic secure deletion from ordinary filesystem removal.

## Dependencies and constraints

- Provider APIs, OAuth flows, subscriptions, model catalogues, and terms are external dependencies.
- Initial runtime is macOS, TypeScript/Node, loopback-only, and private-first.
- Existing services on protected ports remain outside product ownership.
- License/provenance gates precede substantial source reuse.

## Approval

The product owner approves business scope and provider-risk decisions. Engineering, QA, and security review confirm feasibility and evidence but do not silently change BR requirements.
