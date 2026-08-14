import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretHandle } from "../../../src/credentials/env-resolver.js";
import { decideRoute } from "../../../src/core/router.js";
import { decodeAnthropicRequest } from "../../../src/protocols/anthropic/decoder.js";
import { AntigravityBridgeAdapter, parseBridgeUrl } from "../../../src/providers/bridge/antigravity.js";
import { ProviderAdapterError } from "../../../src/providers/provider-adapter.js";
import { ClaudeOAuthAdapter } from "../../../src/providers/oauth/claude/adapter.js";
import { createClaudeOAuthClient, CLAUDE_CLIENT_ID_ENV } from "../../../src/providers/oauth/claude/protocol.js";
import { AlibabaAdapter } from "../../../src/providers/direct/alibaba-adapter.js";
import { OpenCodeGoAdapter } from "../../../src/providers/direct/opencode-go-adapter.js";
import {
  backupClineSource, lockClineInterop, previewClineSource, readClineSource, rejectSilentClineDiscovery,
  restoreClineSource, unlockClineInterop,
} from "../../../src/providers/interop/cline.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const capabilities = {
  streaming: true, tools: true, parallelTools: false, images: false, reasoning: true,
  redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate" as const,
};

function urlOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function decision(providerId: string, adapterId: string) {
  return decideRoute({
    requestId: "request-fixture",
    route: {
      role: "primary", providerId, modelId: "fixture-model", adapterId,
      credentialRef: { kind: "env", name: "FIXTURE_KEY" }, capabilities,
    },
    required: [],
    configFingerprint: "a".repeat(64),
  });
}

describe("provider expansion contracts", () => {
  it("rejects protected-port Antigravity bridges and identity mismatch", async () => {
    expect(() => parseBridgeUrl("http://127.0.0.1:8317")).toThrow(/protected port/);
    expect(() => parseBridgeUrl("http://example.com:9")).toThrow(/loopback/);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      product: "wrong", protocolVersion: 1,
    }), { status: 200 }));
    const adapter = new AntigravityBridgeAdapter(fetchImpl, {
      baseUrl: "http://127.0.0.1:17874",
      expectedIdentity: "rly-gateway-antigravity-bridge",
      expectedProtocolVersion: 1,
    });
    await expect(adapter.probe(decision("antigravity", "antigravity-bridge"), new AbortController().signal))
      .resolves.toMatchObject({ readiness: "unavailable" });
  });

  it("marks Antigravity ready only when the attested identity matches", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      product: "rly-gateway-antigravity-bridge", protocolVersion: 1,
    }), { status: 200 }));
    const adapter = new AntigravityBridgeAdapter(fetchImpl, {
      baseUrl: "http://127.0.0.1:17874",
      expectedIdentity: "rly-gateway-antigravity-bridge",
      expectedProtocolVersion: 1,
    });
    await expect(adapter.probe(decision("antigravity", "antigravity-bridge"), new AbortController().signal))
      .resolves.toMatchObject({ readiness: "ready" });
  });

  it("imports Cline only from an explicit path and restores a lock backup", async () => {
    expect(() => rejectSilentClineDiscovery(undefined)).toThrow(/explicit source path/);
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cline-"));
    directories.push(directory);
    const source = join(directory, "cline-auth.json");
    await writeFile(source, JSON.stringify({ tokens: { access_token: "cline-access-fixture", refresh_token: "cline-refresh-fixture" } }), "utf8");
    const preview = await previewClineSource(source);
    expect(preview.provider).toBe("cline");
    expect(preview.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    await lockClineInterop(directory, source);
    await backupClineSource(directory, source);
    await writeFile(source, "corrupt", "utf8");
    await restoreClineSource(directory, source);
    const restored = await previewClineSource(source);
    expect(restored.sourceFingerprint).toBe(preview.sourceFingerprint);
    await unlockClineInterop(directory);
    await lockClineInterop(directory, source);
    const linked = join(directory, "cline-link.json");
    await symlink(source, linked);
    await expect(readClineSource(linked)).rejects.toThrow(/unreadable/);
    const shapePath = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/upstream/clinepass/auth-shape.json");
    const shape = JSON.parse(await readFile(shapePath, "utf8")) as {
      schema: string;
      requiredKeys: string[];
      tokens: Record<string, string>;
    };
    expect(shape.schema).toBe("cline-oauth-v1");
    expect(shape.requiredKeys).toEqual(["tokens.access_token", "tokens.refresh_token"]);
    expect(shape.tokens["access_token"]).toBe("<omitted>");
    expect(shape.tokens["refresh_token"]).toBe("<omitted>");
  });

  it("keeps OpenCode Go and Alibaba on isolated OpenAI-compatible transports", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      id: "chat_fixture",
      choices: [{ finish_reason: "stop", message: { content: "fixture text" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200 })));
    const request = decodeAnthropicRequest({
      model: "fixture-model", max_tokens: 8, messages: [{ role: "user", content: "fixture" }],
    }).request;
    const go = new OpenCodeGoAdapter(fetchImpl, undefined, { FIXTURE_KEY: "fixture-secret" });
    for await (const event of go.invoke(request, decision("opencode-go", "opencode-go-direct"), new AbortController().signal)) {
      expect(event.requestId).toBe(request.id);
    }
    expect(urlOf(fetchImpl.mock.calls[0]?.[0])).toContain("opencode.ai");
    const alibaba = new AlibabaAdapter(fetchImpl, undefined, { FIXTURE_KEY: "fixture-secret" });
    for await (const event of alibaba.invoke(request, decision("alibaba", "alibaba-direct"), new AbortController().signal)) {
      expect(event.requestId).toBe(request.id);
    }
    expect(urlOf(fetchImpl.mock.calls[1]?.[0])).toContain("dashscope.aliyuncs.com");
  });

  it("sends Claude subscription requests with a request-scoped bearer and no secret events", async () => {
    const secret = new SecretHandle("claude-access-fixture-not-secret");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "msg_fixture",
      content: [{ type: "text", text: "fixture" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 1 },
    }), { status: 200 }));
    const adapter = new ClaudeOAuthAdapter(fetchImpl, secret, "http://127.0.0.1:9");
    const request = decodeAnthropicRequest({
      model: "claude-sonnet-4-6", max_tokens: 8, messages: [{ role: "user", content: "fixture" }],
    }).request;
    const events = [];
    for await (const event of adapter.invoke(request, decision("claude", "claude-oauth"), new AbortController().signal)) {
      events.push(event);
    }
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9/v1/messages");
    expect(JSON.stringify(events)).not.toContain("claude-access-fixture-not-secret");
    const client = createClaudeOAuthClient(fetch, { [CLAUDE_CLIENT_ID_ENV]: "project-owned-claude" });
    expect(client.authorizeUrl({
      state: "s", challenge: "c", redirectUri: "http://127.0.0.1:9/callback",
    })).toContain("project-owned-claude");
    const withTools = decodeAnthropicRequest({
      model: "claude-sonnet-4-6", max_tokens: 8,
      messages: [{ role: "user", content: "fixture" }],
      tools: [{ name: "fixture_tool", input_schema: { type: "object" } }],
    }).request;
    await expect((async () => {
      for await (const event of adapter.invoke(withTools, decision("claude", "claude-oauth"), new AbortController().signal)) {
        expect(event.type).toBe("response-started");
      }
    })()).rejects.toBeInstanceOf(ProviderAdapterError);
  });
});
