# Claude Code Working Contract

Follow [AGENTS.md](./AGENTS.md) as the repository working contract. Before changing behavior, use its task routing to read the owning BA requirements, SPEC/ADR, RTM, Acceptance Test Cases Catalogue, TASKLIST, and active local plan phase.

Claude-specific reminders:

- Keep global Claude configuration unchanged; launch settings are transient.
- Preserve Anthropic Messages tools, reasoning, streaming, usage, stop, helper mapping, cancellation, and concurrency contracts.
- Never invoke a provider before capability and request-time account eligibility checks pass.
- Never retry or rotate accounts after the first response byte or tool event.
