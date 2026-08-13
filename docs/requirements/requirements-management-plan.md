# Requirements Management Plan

## Purpose

Keep product, system, functional, and acceptance requirements consistent, testable, change-controlled, and traceable from intent to evidence.

## Requirement classes

| Prefix | Owner | Example |
| --- | --- | --- |
| `BR-*` | BRD | Business outcome, rule, or constraint |
| `SR-F-*` | SRS | System functional requirement |
| `SR-NF-*` | SRS | Non-functional requirement |
| `FR-*` | FRS | Detailed observable behavior |
| `UC-*` | Use cases | Actor interaction |
| `US-*` | User stories | Delivery slice |
| `AT-*` | Acceptance catalogue | Verification scenario |

IDs are immutable. Deleted intent is marked `Superseded` with a replacement ID. New requirements receive the next unused ID in their class.

## Requirement quality gate

Every committed requirement must be:

- necessary and within accepted scope;
- singular, clear, and free of implementation ambiguity;
- consistent with SPEC and accepted ADRs;
- prioritized `Must`, `Should`, or `Could`;
- verifiable through a named acceptance scenario or explicit inspection;
- traceable upstream and downstream through the RTM;
- safe for public documentation: no credentials, account identity, live payload, or private path dependency.

## Lifecycle

```text
Proposed → Analyzed → Approved → Implemented → Verified
                         ↘ Superseded
                         ↘ Rejected
```

- Product owner approves business scope, provider terms risk, and release gates.
- BA maintains BRD/SRS/FRS/use cases/stories/RTM and records unresolved decisions.
- Engineering confirms feasibility and maps requirements to executable owners.
- QA/security confirms verification method and evidence quality.
- A phase is not accepted while a `Must` requirement lacks evidence.

## Change control

1. State the requested outcome and affected requirement IDs.
2. Assess scope, security, protocol, data, migration, provider terms, tests, and rollback impact.
3. Update the owning authority first: BRD for business change, SRS for system contract, FRS for behavioral detail, ADR for architecture decision.
4. Update RTM and acceptance scenarios in the same change.
5. Preserve prior IDs and mark superseded relationships.
6. Obtain product-owner approval for scope or risk changes before implementation.

## Baselines

- Product baseline: versioned SPEC plus accepted ADRs.
- Requirements baseline: this directory and RTM at a reviewed commit.
- Delivery baseline: active plan phase and TASKLIST.
- Verification baseline: the Acceptance Test Cases Catalogue, executable tests/scripts, and redacted live evidence referenced by the RTM.

Plans and research reports are stateful evidence; they do not silently override evergreen authority.

## Prioritization

- `Must`: required for the accepted V1 outcome or safety boundary.
- `Should`: important but can be deferred without invalidating the current milestone.
- `Could`: optional improvement promoted only through change control.

## Traceability and review cadence

Update the RTM whenever an approved requirement, design owner, or acceptance scenario changes. Review the pack at phase entry, before implementation acceptance, and before release. Provider compatibility facts must be refreshed from live evidence rather than treated as permanent requirements.

## Public-release Git policy

- Development history lives on `dev` and private feature branches.
- Public `main` is an unrelated orphan history.
- A public release branch starts from `main`, receives the approved `dev` snapshot as one commit, and enters `main` through one PR.
- Never merge or rebase `dev` directly into `main`; doing so would connect or expose private history.
- Before snapshotting, exclude local plans, credentials, databases, logs, runtime state, user paths, and private fixtures; run privacy, license, build, and clean-install gates.

## Unresolved questions

- Final approver roles if contributors are added beyond the owner.
- Whether a dedicated requirements validator becomes worthwhile after the first public release.
