# ADR 0002: Managed Bridge Boundary

- Status: Superseded by ADR 0004
- Date: 2026-08-13

## Context

This decision governed the bootstrap and direct-provider milestones. The owner later approved a self-owned local control plane, project-managed OAuth credentials, explicit credential import, and account pools after live study of CCS, OpenCodeX, and claude-proxy. ADR 0004 replaces the credential-ownership restriction while retaining managed bridges as one adapter mode.

Direct APIs and subscription OAuth products have different credential ownership. DeepSeek, OpenRouter, OpenCode Go, and Alibaba Token Plan provide documented key-based endpoints. Codex, Claude, and Google Antigravity subscription access is managed by existing client or bridge software.

## Decision

Separate two adapter kinds:

- `direct`: the gateway resolves an approved secret reference and invokes a documented provider endpoint;
- `managed-bridge`: an external bridge owns OAuth, refresh, account state, and its own lifecycle.

Managed bridge rules:

- V1 is loopback-only unless a later ADR approves a remote TLS endpoint;
- require configured identity, protocol, version range, and capability attestation;
- readiness distinguishes reachable, authenticated, and model usable;
- never read Codex, Claude, Antigravity, CCS, or other client credential stores;
- never install, authenticate, update, start, stop, restart, or kill a bridge;
- fail closed on identity or protocol mismatch;
- treat bridge-side privacy and terms as outside gateway guarantees and document them.

## Consequences

- Subscription routes cannot be enabled until a concrete bridge contract is selected and tested.
- Fake-bridge contract tests precede live bridge integration.
- The gateway can always be bypassed without restoring global client configuration.

## Rejected alternatives

- Reusing OAuth/session tokens from client storage: undocumented and unsafe.
- Implementing provider OAuth clients in V1: unnecessary security and maintenance burden.
- Treating bridges as ordinary OpenAI-compatible APIs: hides double-translation loss.
