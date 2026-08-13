# Requirements Traceability Matrix

## Business-to-acceptance trace

| Business requirement | System requirements | Functional requirements | Use cases / stories | Acceptance |
| --- | --- | --- | --- | --- |
| BR-001 Multiple providers through Claude | SR-F-001, SR-F-003, SR-F-009–012 | FR-008, FR-009, FR-011 | UC-001, UC-005; US-001, US-007 | AT-015–AT-022 |
| BR-002 Central administration | SR-F-004/005/009/011/016/017 | FR-002, FR-007/008/013 | UC-004/006/007; US-004–US-006 | AT-003/004, AT-013–AT-016, AT-025/026 |
| BR-003 Credential ownership | SR-F-006–008, SR-NF-002/003/005/006/008 | FR-003–FR-006 | UC-002/003/006/008; US-002–US-004/010 | AT-005–AT-014 |
| BR-004 Reuse proven MIT code | SR-F-019, SR-NF-011/014 | FR-015 | UC-009; US-009 | AT-028, AT-030 |
| BR-005 Deterministic safe routing | SR-F-010–014, SR-NF-006/007/010/012 | FR-009/010/014 | UC-005/007; US-005/006 | AT-017–AT-020, AT-027 |
| BR-006 Claude first, Codex next | SR-F-001–003/015 | FR-011/012 | UC-001/005; US-007/008 | AT-021–AT-024 |
| BR-007 CLI and local UI | SR-F-009/016/017, SR-NF-004/013 | FR-008/013/014 | UC-001/004/007; US-001/005/006 | AT-015/016, AT-025–AT-027, AT-031 |
| BR-008 Preserve native recovery/process safety | SR-F-015/018, SR-NF-001/004/008 | FR-001/011/012 | UC-001/008; US-001/010 | AT-001/002, AT-021–AT-026 |
| BR-009 Privacy | SR-F-005/016/017/021, SR-NF-002–005/008/009/014 | FR-003–FR-007/013/014/017 | UC-002/003/006/007/008; US-002–US-006/010/011 | AT-005–AT-014, AT-025–AT-032 |
| BR-010 Terms/evidence gates | SR-F-004/005/010, SR-NF-012 | FR-002/007/009/015 | UC-003–UC-005/009; US-004/005/009 | AT-003/004, AT-014, AT-017/018, AT-028 |
| BR-011 Private history/public snapshot | SR-F-019/020, SR-NF-002/010/014 | FR-015/016 | UC-010; US-011/012 | AT-028–AT-030 |
| BR-012 Recoverability | SR-F-008/014/018/021, SR-NF-006/008/014 | FR-001/005/006/010/017 | UC-006/008; US-003/004/010 | AT-002, AT-009–AT-012, AT-019/020, AT-030/032 |

## Business-rule trace

| Rule | Downstream ownership | Acceptance |
| --- | --- | --- |
| BR-R01 Credential existence is not acceptance/readiness | SR-F-005/010; FR-007/009 | AT-014/018 |
| BR-R02 Only authorized owner/admin authenticates/imports | SR-F-006/007/016; FR-003/004/013 | AT-005–AT-008, AT-025/026 |
| BR-R03 One request binds one account/generation | SR-F-012; FR-009 | AT-017/018 |
| BR-R04 No rotation after output/tool event | SR-F-013; FR-010 | AT-019/020 |
| BR-R05 Unverified/incompatible route is unavailable | SR-F-003/004; FR-002/009 | AT-004/018/024 |
| BR-R06 Public snapshot excludes local/private artifacts | SR-F-019/020; FR-015/016 | AT-028–AT-030 |

## Maintenance rule

When a requirement changes, update its owning document and this matrix in the same change. When implementation completes, add the executable evidence reference without replacing the stable acceptance ID. If a Must requirement lacks downstream coverage or current evidence, the phase/release cannot be marked accepted.

## Current baseline status

- BR-001/006/008 have partial verified evidence from the completed Claude direct-provider milestone.
- Control-plane, credential, pool, UI, Codex harness, provenance-copy, and public snapshot requirements are approved but not yet implemented.
- Exact evidence mapping is completed phase by phase; no pending row is represented as passing.
