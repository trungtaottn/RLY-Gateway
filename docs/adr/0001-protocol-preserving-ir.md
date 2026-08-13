# ADR 0001: Protocol-preserving Intermediate Representation

- Status: Accepted
- Date: 2026-08-13

## Context

Claude Code uses Anthropic Messages while Codex CLI uses OpenAI Responses. The protocols have different content-block, item, tool, reasoning, usage, and streaming lifecycles. Reducing both to a small chat-completions shape would silently lose behavior.

## Decision

Use a loss-aware tagged-union intermediate representation:

- canonical requests preserve text, images, tool calls/results, reasoning, redacted reasoning, inference controls, and approved extensions;
- canonical events preserve item/content lifecycle, incremental tool arguments, usage, completion, and failure;
- every translation reports required capabilities and any unsupported semantics;
- routing rejects unsupported required capabilities before invoking an upstream;
- route and capability decisions are immutable for the lifetime of a request.

Claude Code and Anthropic Messages are implemented first. The OpenAI Responses protocol identity and core extension boundary are reserved from the foundation phase; its runtime implementation follows Claude MVP acceptance.

## Consequences

- Provider adapters cannot rely on arbitrary raw-payload passthrough.
- Golden protocol fixtures and event-order tests are release gates.
- A provider may be usable without being marked Claude-ready.
- New protocol fields require an explicit preserve, translate, or reject decision.

## Rejected alternatives

- One generic OpenAI chat-completions schema: too lossy.
- Separate unrelated cores for Claude and Codex: duplicates routing, lifecycle, and provider logic.
- Prompt-derived routing: nondeterministic and outside V1 scope.
