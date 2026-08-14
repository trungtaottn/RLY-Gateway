import { describe, expect, it, vi } from "vitest";
import { SecretHandle } from "../../../../src/credentials/env-resolver.js";
import { decideRoute, type RouteRecord } from "../../../../src/core/router.js";
import { decodeAnthropicRequest } from "../../../../src/protocols/anthropic/decoder.js";
import { CodexOAuthAdapter } from "../../../../src/providers/oauth/codex/adapter.js";
import type { CanonicalEvent } from "../../../../src/core/canonical-event.js";

const route: RouteRecord = {
  role: "primary",
  providerId: "codex",
  modelId: "fixture-model",
  adapterId: "codex-oauth",
  credentialRef: { kind: "handle", handle: "cred-fixture-001" },
  capabilities: { streaming: true, tools: true, parallelTools: false, images: false, reasoning: true, redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate" },
};

describe("codex oauth adapter", () => {
  it("sends a request-scoped secret and never needs a credential file", async () => {
    const secret = new SecretHandle("access-token-fixture-not-secret");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "chat_fixture",
      choices: [{ finish_reason: "stop", message: { content: "fixture text" } }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }), { status: 200 }));
    const adapter = new CodexOAuthAdapter(fetch, secret, "http://127.0.0.1:9");
    const request = decodeAnthropicRequest({ model: "fixture-model", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] }).request;
    const events: CanonicalEvent[] = [];
    for await (const event of adapter.invoke(request, decideRoute({
      requestId: request.id,
      route,
      required: [],
      configFingerprint: "a".repeat(64),
      accountPseudonym: "acct-fixture-001",
      credentialGeneration: 1,
    }), new AbortController().signal)) events.push(event);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9/chat/completions");
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe("Bearer " + "access-token-fixture-not-secret");
    expect(events.map((item) => item.type)).toContain("response-completed");
    expect(JSON.stringify(events)).not.toMatch(/access-token-fixture-not-secret/);
    expect(secret.reveal()).toBe("access-token-fixture-not-secret");
  });
});
