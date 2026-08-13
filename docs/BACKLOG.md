# Agent Gateway Backlog

Items here are not committed V1 scope. Promotion requires evidence, owner approval, and an update to SPEC/roadmap/plan as appropriate.

## Near-term candidates

- macOS Keychain backend as an alternative to project-owned credential files.
- Rich diagnostic bundle with an explicit metadata allowlist.
- Provider catalog refresh command that proposes, but never silently applies, registry changes.
- Compatibility canary for newly installed Claude Code and Codex CLI versions.
- Native/local exact tokenizer support where licensing and model parity are verified.

## Provider expansion

- Additional providers beyond the committed Codex OAuth, Gemini, Cline, Claude, OpenCode Go, Alibaba, and bridge sequence.
- Anthropic API direct adapter.
- OpenAI API-key direct adapter separate from Codex subscription bridge.
- Gemini API direct adapter separate from Antigravity subscription bridge.
- Z.AI/GLM coding plan.
- Additional coding plans only after terms and protocol capability review.

## Routing evolution

- Ordered manual failover after duplicate-tool and retry safety are proven.
- Cost, latency, or capability policy routing only with deterministic decision traces.

## Operations and distribution

- Optional macOS launchd service after foreground ownership is stable.
- Linux service support.
- Signed package or standalone distribution.
- Remote TLS bridge support with explicit trust configuration.

## Explicitly rejected until new evidence

- Prompt-content model routing.
- Silent provider/model substitution.
- Blind port-owner termination.
- Silent credential discovery/import from client storage.
- Automatic OAuth client impersonation.
- Default logging of prompts or responses.

## Promotion checklist

Before moving an item to `TASKLIST.md`:

1. State the user outcome and acceptance criteria.
2. Identify security, terms, protocol, and lifecycle boundaries.
3. Add or update an ADR if architecture changes.
4. Update `SPEC.md` and `ROADMAP.md` if release scope changes.
5. Create an executable plan phase with tests and rollback.

## Unresolved questions

- Backlog priority will be reassessed after Claude MVP usage evidence.
