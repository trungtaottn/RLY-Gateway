# Contributing To Agent Gateway

Before work, follow [AGENTS.md](./AGENTS.md) and route the task through the [requirements pack](./docs/requirements/README.md). Requirement or behavior changes must preserve IDs, update RTM/acceptance evidence, and reconcile the owning authority before completion.

This repository is initially personal, but all changes should be reviewable and publishable without exposing private machine state.

## Before changing code

1. Route the task through the [requirements pack](./docs/requirements/README.md), [SPEC.md](./docs/SPEC.md), and relevant ADRs.
2. Check [TASKLIST.md](./docs/TASKLIST.md), RTM/acceptance IDs, and the active plan phase.
3. Confirm the work is committed scope; otherwise place it in [BACKLOG.md](./docs/BACKLOG.md).
4. Inspect current provider/protocol compatibility evidence.
5. Never paste or commit credentials, real prompts, responses, account identity, or private provider payloads.

## Development loop

```text
fixture or failing test
→ smallest contract-aligned implementation
→ focused test
→ shared type/lint/build gates
→ lifecycle/privacy gates when relevant
→ independent review
→ plan/tasklist sync
```

Protocol drift must begin with a redacted reproducing fixture. Provider changes must update capability evidence, fixture revision, verification date, and compatibility docs.

## Git workflow

- Keep commits small and conventional.
- Do not commit unless explicitly approved by the repository owner.
- Never rewrite or discard unrelated local work.
- Do not add an upstream remote merely because code was studied or adapted.
- Record copied or substantially adapted MIT code in `docs/provenance.md` before commit.

## Safety rules

- Never signal a process based only on port occupancy.
- Never use existing protected ports `10100`, `8317`, or `17870` for this project.
- Never persist global Claude/Codex configuration in normal launch paths.
- Credential import/interoperability may read another client store only when explicitly requested by the owner and governed by the credential broker contract.
- Never retry after response bytes or a tool event have been emitted.
- Live tests are opt-in and must not log real content.

## Definition of done

- Acceptance criteria for the active phase are met.
- Focused and shared tests pass.
- No new lint, type, or build errors.
- Public/config/protocol contracts changed only intentionally and are documented.
- Privacy scan passes.
- Relevant docs and plan state reflect reality.
- Independent reviewer reports no critical blocker.

## Documentation ownership

| Change | Update |
| --- | --- |
| Product behavior or scope | Owning requirements document, `docs/SPEC.md`, and RTM |
| Current committed work | `docs/TASKLIST.md` and active plan |
| Uncommitted future idea | `docs/BACKLOG.md` |
| Milestone sequence | `docs/ROADMAP.md` |
| Durable architecture | `docs/ARCHITECTURE.md` and ADR when needed |
| Runtime/tool policy | `docs/TECH-STACK.md` |
| Provider/protocol compatibility | compatibility docs introduced by their implementation phase |
| Verified requirement | RTM evidence, Acceptance Test Cases if scenario changed, TASKLIST and active phase |

Do not duplicate detailed phase steps into evergreen docs.

## Unresolved questions

- None for bootstrap contributors.
