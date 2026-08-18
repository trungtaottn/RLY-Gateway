import { describe, expect, it, vi } from "vitest";
import { SecretHandle } from "../../../src/credentials/env-resolver.js";
import { OAuthFlowError } from "../../../src/credentials/errors.js";
import { decideRoute, type RouteRecord } from "../../../src/core/router.js";
import { decodeAnthropicRequest } from "../../../src/protocols/anthropic/decoder.js";
import { GeminiOAuthAdapter, GEMINI_OAUTH_ENDPOINT } from "../../../src/providers/oauth/gemini/adapter.js";
import { createGeminiOAuthClient, GEMINI_CLIENT_ID_ENV } from "../../../src/providers/oauth/gemini/protocol.js";

function urlOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const route: RouteRecord = {
  role: "primary",
  providerId: "gemini",
  modelId: "gemini-2.5-flash",
  adapterId: "gemini-oauth",
  credentialRef: { kind: "handle", handle: "cred-fixture-001" },
  capabilities: {
    streaming: true, tools: true, parallelTools: false, images: false, reasoning: true,
    redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate",
  },
};

describe("gemini oauth adapter", () => {
  it("uses a project-owned client id and the public Gemini API, not Code Assist", async () => {
    const client = createGeminiOAuthClient(fetch, { [GEMINI_CLIENT_ID_ENV]: "project-owned-client" });
    const url = client.authorizeUrl({ state: "state", challenge: "challenge", redirectUri: "http://127.0.0.1:9/callback" });
    expect(url).toContain("accounts.google.com");
    expect(url).toContain("project-owned-client");
    expect(url).not.toContain("cloudcode-pa.googleapis.com");
    expect(() => createGeminiOAuthClient(fetch, {}).authorizeUrl({
      state: "state", challenge: "challenge", redirectUri: "http://127.0.0.1:9/callback",
    })).toThrow(OAuthFlowError);

    const secret = new SecretHandle("access-token-fixture-not-secret");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "chat_fixture",
      choices: [{ finish_reason: "stop", message: { content: "fixture text" } }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }), { status: 200 }));
    const adapter = new GeminiOAuthAdapter(fetchImpl, secret);
    const request = decodeAnthropicRequest({
      model: "gemini-2.5-flash", max_tokens: 8, messages: [{ role: "user", content: "fixture" }],
    }).request;
    const events = [];
    for await (const event of adapter.invoke(request, decideRoute({
      requestId: request.id, route, required: [], configFingerprint: "a".repeat(64),
    }), new AbortController().signal)) events.push(event);
    expect(urlOf(fetchImpl.mock.calls[0]?.[0])).toBe(`${GEMINI_OAUTH_ENDPOINT}/chat/completions`);
    expect(JSON.stringify(events)).not.toMatch(/access-token-fixture-not-secret/);
  });
});
