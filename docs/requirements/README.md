# Requirements Pack

This directory is the requirements authority for Agent Gateway. It is structured for the owner, business analysis, engineering, QA, security review, and future public contributors.

## Document map

| Artifact | Decision it owns |
| --- | --- |
| [Project vision](./project-vision.md) | Product purpose, outcomes, scope, stakeholders, success |
| [Requirements management plan](./requirements-management-plan.md) | Requirement IDs, lifecycle, change control, validation, baselines |
| [BRD](./business-requirements.md) | Business outcomes, capabilities, rules, constraints |
| [SRS](./system-requirements.md) | System functional and non-functional requirements |
| [FRS](./functional-requirements.md) | Detailed behavior, preconditions, flows, errors, acceptance |
| [Use cases](./use-cases.md) | Actor-to-system interaction flows |
| [User stories](./user-stories.md) | Delivery slices and acceptance outcomes |
| [RTM](./requirements-traceability-matrix.md) | Trace from business need to system/function/test |
| [Acceptance test cases catalogue](./acceptance-test-cases.md) | Canonical Test Cases artifact with verifiable business/system acceptance scenarios |

## Authority and evidence

- Product authority: [SPEC](../SPEC.md), [project decisions](../project-decisions.md), and accepted [ADRs](../adr/).
- Architecture authority: [ARCHITECTURE](../ARCHITECTURE.md).
- Delivery state: [TASKLIST](../TASKLIST.md) and the local active plan referenced there.
- Executable evidence: `src/`, `tests/`, `scripts/`, and package commands.

The requirements pack owns WHY and observable contracts. Code and tests own implementation details. Requirement IDs remain stable; obsolete requirements are marked superseded rather than renumbered.

## Agent reading and update matrix

| Work type | Read first | Update when finished |
| --- | --- | --- |
| Product/scope/priority | Vision, BRD, SPEC, project decisions | Owning BR/SPEC decision, RTM, roadmap/backlog |
| Architecture/security/data | SRS, ARCHITECTURE, SECURITY, relevant ADR | SRS/ADR/security contract, RTM, acceptance scenarios |
| Feature/provider | FRS, use cases, stories, RTM, provenance, active phase | FRS if behavior changed, RTM evidence, TASKLIST/phase, provenance |
| Credential/pool/management | SRS NFRs, FR-003–FR-010/013, Acceptance Test Cases | Security/recovery evidence, RTM, phase status |
| Protocol/lifecycle | SRS, protocol compatibility, architecture, Acceptance Test Cases | Compatibility contract, fixtures/evidence, RTM, phase |
| Bug fix | Affected FR/SR/AT and executable reproduction | Test evidence; requirement only if expected behavior changed |
| Test/review/release | RTM, Acceptance Test Cases, SECURITY, provenance | Evidence references, unresolved gaps, TASKLIST/release phase |

Repository agents follow `AGENTS.md`. Claude Code also reads the concise `CLAUDE.md` pointer. Plans/reports are local state and cannot override accepted product authority.
