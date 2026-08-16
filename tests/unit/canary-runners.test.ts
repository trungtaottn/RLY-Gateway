import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { runInstalledClientMatrix } from "../../src/canary/installed-runner.js";
import { runLiveAccessPath } from "../../src/canary/live-runner.js";
import { claimKeyFor, claimStatusFor, requiredLayersForAdapter } from "../../src/canary/claim.js";
import { CLAUDE_CODE_CONTRACT, CODEX_CLI_CONTRACT } from "../../src/canary/client-fixtures.js";
import { createClaudeChildEnvironment, createCodexChildEnvironment } from "../../src/runtime/child-launcher.js";
import { assertSecretFree } from "../../src/control-plane/secret-free.js";
import type { ClaimFeature } from "../../src/canary/claim.js";
import type { ChildInvocation, InvocationContext, RunnerGateObservation } from "../../src/canary/runner-types.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "clients");
const fakeClaudePath = join(fixturesDir, "fake-claude.mjs");
const fakeCodexPath = join(fixturesDir, "fake-codex.mjs");
const directories: string[] = [];
const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fakeClaudeInvoke(context: InvocationContext): ChildInvocation {
  return {
    executable: process.execPath,
    args: [fakeClaudePath],
    env: {
      ...createClaudeChildEnvironment(context.environment, context.fixtureBaseUrl, "fixture-token-blackbox", context.configDirectory),
      RLY_BLACKBOX_GATE: context.gate,
      RLY_BLACKBOX_FIXTURE_URL: context.fixtureBaseUrl,
      RLY_BLACKBOX_CONFIG_DIR: context.configDirectory,
      RLY_BLACKBOX_SESSION_ID: context.sessionId,
    },
  };
}

function fakeCodexInvoke(context: InvocationContext): ChildInvocation {
  return {
    executable: process.execPath,
    args: [fakeCodexPath],
    env: {
      ...createCodexChildEnvironment(context.environment, context.fixtureBaseUrl, "fixture-token-blackbox", context.configDirectory),
      RLY_BLACKBOX_GATE: context.gate,
      RLY_BLACKBOX_FIXTURE_URL: context.fixtureBaseUrl,
      RLY_BLACKBOX_CONFIG_DIR: context.configDirectory,
      RLY_BLACKBOX_SESSION_ID: context.sessionId,
    },
  };
}

function resultFor(gates: readonly RunnerGateObservation[], gate: string): RunnerGateObservation | undefined {
  return gates.find((candidate) => candidate.gate === gate);
}

// ---------------------------------------------------------------------------
// Layer B — installed-client black-box
// ---------------------------------------------------------------------------

describe("Layer B installed-client runner (#123)", () => {
  it("runs the full Claude Code black-box matrix through a deterministic fake client", async () => {
    const summary = await runInstalledClientMatrix({
      client: "claude-code",
      executable: process.execPath,
      observedVersion: "2.1.231",
      supportedBaseline: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      invoke: fakeClaudeInvoke,
      now: () => "1970-01-01T00:00:00.000Z",
    });
    expect(summary.error).toBeUndefined();
    expect(summary.observedVersion).toBe("2.1.231");
    expect(summary.supportedBaseline).toBe("claude-code-2.1.229");
    // Observed version is distinct from the reviewed baseline and recorded separately.
    expect(summary.observedVersion).not.toBe(summary.supportedBaseline);
    const gates = new Set(summary.gates.map((gate) => gate.gate));
    expect(gates).toEqual(new Set([
      "text", "streaming", "cancellation", "tools-single", "tools-multi", "tools-parallel",
      "reasoning", "reasoning-tools", "model-discovery", "session-attribution", "subagent-routing",
      "subagent-parallel", "effort-signal", "long-running-session", "config-overlay",
    ]));
    const failed = summary.gates.filter((gate) => gate.result === "failed");
    const notRun = summary.gates.filter((gate) => gate.result === "not-run");
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(notRun).toEqual([]);
    expect(summary.gates.every((gate) => gate.result === "passed")).toBe(true);
    // Evidence records: layer B, kind installed-client, timing present.
    expect(summary.evidence.length).toBe(summary.gates.length);
    for (const record of summary.evidence) {
      expect(record.layer).toBe("B");
      expect(record.kind).toBe("installed-client");
      expect(record.result).toBe("passed");
      expect(record.timingMs).toBeGreaterThan(0);
      expect(record.claimKey).toContain("claude-code");
      expect(record.claimKey.split("|")[2]).toBe("2.1.231");
      expect(record.claimKey.split("|")[2]).not.toBe("2.1.229");
      expect(record.claimKey).toContain("installed-client-blackbox");
    }
    expect(summary.claims.length).toBe(summary.gates.length);
    // Observed-version claim documents cannot be promoted: Layer A/C are absent.
    for (const claim of summary.claims) {
      expect(claimStatusFor(claim)).toBe("not-run");
      expect(requiredLayersForAdapter("installed-client-blackbox")).toEqual(["A", "B", "C"]);
    }
    assertSecretFree(summary);
    assertSecretFree(summary.claims);
    assertSecretFree(summary.evidence);
    const serialized = JSON.stringify({ gates: summary.gates, evidence: summary.evidence });
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}|OPENROUTER_API_KEY|api[_-]?key\s*[:=]/i);
  }, 120_000);

  it("runs the full Codex CLI black-box matrix through a deterministic fake client", async () => {
    const summary = await runInstalledClientMatrix({
      client: "codex-cli",
      executable: process.execPath,
      observedVersion: "0.147.0-alpha.6.5",
      supportedBaseline: "codex-cli-observed",
      contract: CODEX_CLI_CONTRACT,
      invoke: fakeCodexInvoke,
      now: () => "1970-01-01T00:00:00.000Z",
    });
    const failed = summary.gates.filter((gate) => gate.result === "failed");
    const notRun = summary.gates.filter((gate) => gate.result === "not-run");
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(notRun).toEqual([]);
    expect(summary.gates.length).toBeGreaterThanOrEqual(9);
    for (const record of summary.evidence) {
      expect(record.layer).toBe("B");
      expect(record.kind).toBe("installed-client");
      expect(record.claimKey).toContain("codex-cli");
      expect(record.claimKey).toContain("openai-responses");
    }
  }, 120_000);

  it("emits a typed exact gate failure keyed to the client version when wire behavior drifts", async () => {
    // A broken fake client that omits the session attribution header.
    const brokenInvoke = (context: InvocationContext): ChildInvocation => {
      const base = fakeClaudeInvoke(context);
      return {
        ...base,
        env: {
          ...base.env,
          RLY_BLACKBOX_GATE: "drop-session-header",
        },
      };
    };
    const summary = await runInstalledClientMatrix({
      client: "claude-code",
      executable: process.execPath,
      observedVersion: "9.9.9-drift",
      supportedBaseline: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      invoke: brokenInvoke,
      now: () => "1970-01-01T00:00:00.000Z",
    });
    const attribution = resultFor(summary.gates, "session-attribution");
    expect(attribution).toBeDefined();
    expect(attribution?.result).toBe("failed");
    expect(attribution?.failureReason).toBe("missing-agent-header");
    // The failing record is keyed to the drifting client version.
    const record = summary.evidence.find((candidate) => candidate.feature === "session-attribution");
    expect(record?.claimKey).toContain("9.9.9-drift");
    expect(record?.result).toBe("failed");
    expect(record?.failureReason).toBe("missing-agent-header");
  }, 120_000);

  it("never reports a missing/non-executable client as PASS — all gates are not-run", async () => {
    const summary = await runInstalledClientMatrix({
      client: "claude-code",
      executable: "/nonexistent/rly-claude-binary",
      observedVersion: "unknown",
      supportedBaseline: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      now: () => "1970-01-01T00:00:00.000Z",
    });
    expect(summary.error).toBe("client-not-installed");
    expect(summary.gates.length).toBeGreaterThan(0);
    expect(summary.gates.every((gate) => gate.result === "not-run")).toBe(true);
    expect(summary.gates.every((gate) => gate.failureReason === "client-not-installed")).toBe(true);
    expect(summary.evidence.every((record) => record.result === "not-run")).toBe(true);
    // Not-run records never look like PASS.
    expect(summary.evidence.some((record) => record.result === "passed")).toBe(false);
  }, 30_000);

  it("keeps distinct claim keys per feature and per observed client version", async () => {
    const summary = await runInstalledClientMatrix({
      client: "claude-code",
      executable: process.execPath,
      observedVersion: "2.1.231",
      supportedBaseline: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      invoke: fakeClaudeInvoke,
      now: () => "1970-01-01T00:00:00.000Z",
    });
    const keys = new Set(summary.evidence.map((record) => record.claimKey));
    expect(keys.size).toBe(summary.evidence.length);
    const textClaim = summary.claims.find((claim) => claim.feature === "text");
    const reasoningClaim = summary.claims.find((claim) => claim.feature === "reasoning");
    expect(textClaim).toBeDefined();
    expect(reasoningClaim).toBeDefined();
    const baseIdentity = summary.claims[0]?.claimIdentity;
    if (baseIdentity === undefined) throw new Error("no claim documents produced");
    const textKey = claimKeyFor(textClaim?.claimIdentity ?? baseIdentity, "text");
    const reasoningKey = claimKeyFor(reasoningClaim?.claimIdentity ?? baseIdentity, "reasoning");
    // The text record is keyed to the exact observed version (identity slot), not the baseline.
    expect(summary.evidence.some((record) => record.claimKey === textKey)).toBe(true);
    const textParts = textKey.split("|");
    expect(textParts[2]).toBe("2.1.231");
    expect(textParts[2]).not.toBe("2.1.229");
    expect(textKey).not.toBe(reasoningKey);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Layer C — live access path
// ---------------------------------------------------------------------------

type ProviderMode = "happy" | "unauthorized" | "rate-limit" | "provider-error";

function createFakeProvider(mode: ProviderMode): FastifyInstance {
  const app = Fastify({ logger: false });
  const chatCompletion = (text: string, toolCalls?: readonly unknown[]): Record<string, unknown> => ({
    id: "chatcmpl-fixture",
    object: "chat.completion",
    created: 0,
    model: "fixture-model",
    choices: [{ index: 0, message: { role: "assistant", content: toolCalls === undefined ? text : null, tool_calls: toolCalls }, finish_reason: toolCalls === undefined ? "stop" : "tool_calls" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  app.post("/chat/completions", async (request, reply) => {
    const body = request.body as Readonly<{
      model?: unknown; stream?: unknown; messages?: readonly Readonly<{ role?: unknown }>[]; tools?: readonly unknown[];
    }>;
    if (mode === "unauthorized") {
      return reply.code(401).send({ error: { message: "invalid key", type: "invalid_request_error", code: "invalid_api_key" } });
    }
    if (mode === "rate-limit") {
      return reply.code(429).send({ error: { message: "rate limit", type: "rate_limit_error", code: "rate_limit_exceeded" } });
    }
    if (mode === "provider-error") {
      return reply.code(502).send({ error: { message: "upstream", type: "server_error", code: "bad_gateway" } });
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const hasToolResult = messages.some((message) => message !== null && typeof message === "object" && "role" in message && (message as { role?: unknown }).role === "tool");
    const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
    if (body.stream === true) {
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      reply.raw.write('data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"FIXTURE_LIVE_OK"}}]}\n\n');
      reply.raw.write('data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return;
    }
    if (hasToolResult) {
      return reply.send(chatCompletion("FIXTURE_TOOL_CONTINUATION_OK"));
    }
    if (toolCount >= 2) {
      return reply.send(chatCompletion("", [
        { id: "call_a", type: "function", function: { name: "Bash", arguments: "{\"command\":\"printf fixture\"}" } },
        { id: "call_b", type: "function", function: { name: "Grep", arguments: "{\"pattern\":\"fixture\"}" } },
      ]));
    }
    if (toolCount === 1) {
      return reply.send(chatCompletion("", [
        { id: "call_a", type: "function", function: { name: "Bash", arguments: "{\"command\":\"printf fixture\"}" } },
      ]));
    }
    return reply.send(chatCompletion("FIXTURE_LIVE_OK"));
  });
  return app;
}

function liveSpec(providerUrl: string, provider: string, model: string, environment: NodeJS.ProcessEnv, credentialEnvName = "FIXTURE_API_KEY") {
  const adapterId = provider === "openrouter" ? "openrouter-direct" : provider === "deepseek" ? "deepseek-direct" : `${provider}-adapter`;
  return {
    client: "claude-code" as const,
    clientVersion: CLAUDE_CODE_CONTRACT.baseline,
    contract: CLAUDE_CODE_CONTRACT,
    adapterId,
    accessProviderId: provider,
    authMode: provider === "openrouter" ? ("direct-api-key" as const) : ("direct-api-key" as const),
    endpointContract: "anthropic-messages" as const,
    physicalModelId: model,
    providerBaseUrl: providerUrl,
    credentialEnvName,
    environment,
    now: () => "1970-01-01T00:00:00.000Z",
  };
}

describe("Layer C live access-path runner (#123)", () => {
  it("executes an exact provider path and emits feature-scoped Evidence v2 (never a boolean)", async () => {
    const provider = createFakeProvider("happy");
    servers.push(provider);
    const providerUrl = await provider.listen({ host: "127.0.0.1", port: 0 });
    const summary = await runLiveAccessPath(liveSpec(providerUrl, "openrouter", "nvidia/nemotron-3.5-lightning:free", { FIXTURE_API_KEY: "fixture-secret-0001" }));
    expect(summary.error).toBeUndefined();
    const byGate = new Map(summary.gates.map((gate) => [gate.gate, gate]));
    const expectedPassing: readonly ClaimFeature[] = ["text", "streaming", "tools-single", "tools-multi", "tools-parallel", "reasoning", "reasoning-tools", "model-discovery", "session-attribution", "effort-signal"];
    for (const gate of expectedPassing) {
      const result = byGate.get(gate);
      expect(result, `gate ${gate}`).toBeDefined();
      expect(result?.result, `gate ${gate} = ${JSON.stringify(result)}`).toBe("passed");
    }
    // Cancellation is exercised client-side; the exact path must tolerate it.
    expect(byGate.get("cancellation")?.result).toBe("passed");
    // Feature-scoped: distinct claim keys per feature, layer C records with timing.
    expect(summary.evidence.length).toBe(summary.gates.length);
    for (const record of summary.evidence) {
      expect(record.layer).toBe("C");
      expect(record.kind).toBe("live-access-path");
      expect(record.timingMs).toBeGreaterThan(0);
      expect(record.claimKey).toContain("openrouter");
      expect(record.claimKey).toContain("nvidia/nemotron-3.5-lightning:free");
      expect(record.claimKey).toContain("claude-code");
      expect(record.claimKey).toContain(CLAUDE_CODE_CONTRACT.baseline);
    }
    expect(summary.claims.length).toBe(summary.gates.length);
    for (const claim of summary.claims) {
      expect(claim.records[0]?.layer).toBe("C");
      expect(claim.records[0]?.result).toBe("passed");
    }
    // Secret-free: no credential, no provider error body, no prompt/response.
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("fixture-secret-0001");
    expect(serialized).not.toContain("FIXTURE_LIVE_OK");
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/);
    assertSecretFree(summary);
  }, 120_000);

  it("never promotes across providers: the same upstream model via two access providers yields distinct keys/evidence", async () => {
    const providerA = createFakeProvider("happy");
    const providerB = createFakeProvider("happy");
    servers.push(providerA, providerB);
    const [urlA, urlB] = await Promise.all([
      providerA.listen({ host: "127.0.0.1", port: 0 }),
      providerB.listen({ host: "127.0.0.1", port: 0 }),
    ]);
    const left = await runLiveAccessPath(liveSpec(urlA, "openrouter", "deepseek-v4-pro", { FIXTURE_API_KEY: "fixture-secret-0001" }));
    const right = await runLiveAccessPath(liveSpec(urlB, "deepseek", "deepseek-v4-pro", { FIXTURE_API_KEY: "fixture-secret-0001" }));
    const keyOf = (summary: { evidence: readonly { claimKey: string }[] }): string => {
      const text = summary.evidence.find((record) => record.claimKey.includes("|text"));
      if (text === undefined) throw new Error("no text claim");
      return text.claimKey;
    };
    expect(keyOf(left)).not.toBe(keyOf(right));
    expect(left.evidence.every((record) => record.claimKey.startsWith("v2|claude-code|"))).toBe(true);
    expect(right.evidence.every((record) => record.claimKey.includes("|deepseek-direct|deepseek|"))).toBe(true);
  }, 120_000);

  it("reports missing credentials as not-run for every gate — never PASS, no upstream calls", async () => {
    let calls = 0;
    const provider = Fastify({ logger: false });
    provider.post("/chat/completions", async (_request, reply) => {
      calls += 1;
      return reply.send({});
    });
    servers.push(provider);
    const providerUrl = await provider.listen({ host: "127.0.0.1", port: 0 });
    const summary = await runLiveAccessPath(liveSpec(providerUrl, "openrouter", "nvidia/nemotron-3.5-lightning:free", {}));
    expect(summary.error).toBe("authentication-credentials-unavailable");
    expect(summary.gates.length).toBeGreaterThan(0);
    expect(summary.gates.every((gate) => gate.result === "not-run")).toBe(true);
    expect(summary.gates.every((gate) => gate.failureReason === "authentication-credentials-unavailable")).toBe(true);
    expect(summary.evidence.every((record) => record.result === "not-run")).toBe(true);
    expect(summary.evidence.some((record) => record.result === "passed")).toBe(false);
    // Missing credentials never spend quota: zero upstream requests.
    expect(calls).toBe(0);
  }, 60_000);

  it("classifies provider auth failures and rate limits with typed reasons", async () => {
    const unauthorized = createFakeProvider("unauthorized");
    const rateLimited = createFakeProvider("rate-limit");
    const erroring = createFakeProvider("provider-error");
    servers.push(unauthorized, rateLimited, erroring);
    const [urlAuth, urlRate, urlError] = await Promise.all([
      unauthorized.listen({ host: "127.0.0.1", port: 0 }),
      rateLimited.listen({ host: "127.0.0.1", port: 0 }),
      erroring.listen({ host: "127.0.0.1", port: 0 }),
    ]);
    const auth = await runLiveAccessPath(liveSpec(urlAuth, "openrouter", "nvidia/nemotron-3.5-lightning:free", { FIXTURE_API_KEY: "fixture-secret-0001" }, "FIXTURE_API_KEY"));
    const textAuth = resultFor(auth.gates, "text");
    expect(textAuth?.result).toBe("failed");
    expect(textAuth?.failureReason).toBe("authentication-failure");
    const rate = await runLiveAccessPath(liveSpec(urlRate, "openrouter", "nvidia/nemotron-3.5-lightning:free", { FIXTURE_API_KEY: "fixture-secret-0001" }, "FIXTURE_API_KEY"));
    const textRate = resultFor(rate.gates, "text");
    expect(textRate?.result).toBe("failed");
    expect(textRate?.failureReason).toBe("provider-rate-limit");
    const error = await runLiveAccessPath(liveSpec(urlError, "openrouter", "nvidia/nemotron-3.5-lightning:free", { FIXTURE_API_KEY: "fixture-secret-0001" }, "FIXTURE_API_KEY"));
    const textError = resultFor(error.gates, "text");
    expect(textError?.result).toBe("failed");
    expect(textError?.failureReason).toBe("provider-unavailable");
  }, 120_000);

  it("marks tools-multi/parallel not-run (never passed) when the provider does not call a tool", async () => {
    const provider = Fastify({ logger: false });
    provider.post("/chat/completions", async (request, reply) => {
      // Provider accepts the tool request but never calls a tool.
      const body = request.body as Readonly<{ messages?: readonly Readonly<{ role?: unknown }>[] }>;
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const hasToolResult = messages.some((message) => message !== null && typeof message === "object" && "role" in message && (message as { role?: unknown }).role === "tool");
      void hasToolResult;
      return reply.send({
        id: "chatcmpl-fixture", object: "chat.completion", created: 0, model: "fixture-model",
        choices: [{ index: 0, message: { role: "assistant", content: "I will not call tools." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    servers.push(provider);
    const providerUrl = await provider.listen({ host: "127.0.0.1", port: 0 });
    const summary = await runLiveAccessPath({
      ...liveSpec(providerUrl, "openrouter", "nvidia/nemotron-3.5-lightning:free", { FIXTURE_API_KEY: "fixture-secret-0001" }),
      gates: ["text", "tools-multi"] as readonly ClaimFeature[],
    });
    expect(resultFor(summary.gates, "text")?.result).toBe("passed");
    const multi = resultFor(summary.gates, "tools-multi");
    expect(multi?.result).toBe("not-run");
    expect(multi?.failureReason).toBe("provider-did-not-call-tool");
    const record = summary.evidence.find((candidate) => candidate.feature === "tools-multi");
    expect(record?.result).toBe("not-run");
    expect(record?.failureReason).toBe("provider-did-not-call-tool");
    expect(summary.evidence.some((candidate) => candidate.feature === "tools-multi" && candidate.result === "passed")).toBe(false);
  }, 120_000);
});
