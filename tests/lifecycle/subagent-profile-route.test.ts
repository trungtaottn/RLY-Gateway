import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { AgentExecutionContextRegistry } from "../../src/profiles/agent-contexts.js";
import { LaunchSessionRegistry } from "../../src/profiles/sessions.js";
import { RouteTraceRing } from "../../src/profiles/traces.js";
import { createGatewayServer } from "../../src/runtime/gateway-server.js";
import { LeaseManager } from "../../src/runtime/lease-manager.js";
import { AffinityStore } from "../../src/routing/pools/affinity.js";
import { RouteSelector } from "../../src/routing/pools/selector.js";
import { gatewayConfigSchema } from "../../src/config/schema.js";
import { seedClineClaudeProfile, sseFixture } from "../helpers/cline-profile-seed.js";

const directories: string[] = [];
let app: FastifyInstance | undefined;
let store: ControlPlaneStore | undefined;
let broker: CredentialBroker | undefined;
let provider: FastifyInstance | undefined;
let leases: LeaseManager | undefined;
let agentContexts: AgentExecutionContextRegistry | undefined;
let traces: RouteTraceRing | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await provider?.close();
  provider = undefined;
  await broker?.close();
  broker = undefined;
  store?.close();
  store = undefined;
  leases?.dispose();
  leases = undefined;
  agentContexts = undefined;
  traces = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function openApp(directory: string, endpoint: string, modelRoles?: Readonly<Record<string, string>>) {
  store = await ControlPlaneStore.open(directory);
  broker = await CredentialBroker.open(directory);
  await seedClineClaudeProfile(store, broker, directory, {
    endpoint,
    ...(modelRoles === undefined ? {} : { modelRoles }),
  });
  leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
  const sessions = new LaunchSessionRegistry((id) => leases?.has(id) === true);
  agentContexts = new AgentExecutionContextRegistry((id) => leases?.has(id) === true);
  traces = new RouteTraceRing();
  const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17892, logLevel: "silent" } });
  app = createGatewayServer({
    host: "127.0.0.1",
    port: 17892,
    authToken: "instance-secret",
    instanceId: "00000000-0000-4000-8000-000000000401",
    configFingerprint: "c".repeat(64),
    config,
    controlPlane: store,
    broker,
    selector: new RouteSelector(store, new AffinityStore(directory)),
    launchSessions: sessions,
    agentContexts,
    traces,
    leases,
  });
  return { traces, agentContexts };
}

function requireApp(): FastifyInstance {
  if (!app) throw new Error("missing gateway");
  return app;
}

async function issueToken(): Promise<string> {
  const leaseId = "00000000-0000-4000-8000-000000000411";
  if (!leases) throw new Error("missing leases");
  await leases.add(leaseId);
  const issued = await requireApp().inject({
    method: "POST",
    url: "/v1/launch-sessions",
    headers: { authorization: "Bearer instance-secret", "content-type": "application/json" },
    payload: { profileName: "clinepass", leaseId },
  });
  expect(issued.statusCode).toBe(201);
  const body: unknown = issued.json();
  const token = body && typeof body === "object" && "token" in body && typeof body.token === "string" ? body.token : "";
  expect(token).not.toBe("");
  return token;
}

function agentHeaders(session: string, agent: string, parent?: string): Record<string, string> {
  return {
    "x-claude-code-session-id": session,
    "x-claude-code-agent-id": agent,
    ...(parent === undefined ? {} : { "x-claude-code-parent-agent-id": parent }),
  };
}

type TraceShape = {
  traces: {
    agentLinkage?: {
      claudeSessionPseudonym?: string;
      agentPseudonym?: string;
      parentAgentPseudonym?: string;
      contextSource?: string;
      parentModelId?: string;
      parentModelFamily?: string;
    };
    tierResolution?: {
      requestedTier?: string;
      accessProviderId?: string;
      modelFamily?: string;
      parentModelId?: string;
      mappingSource?: string;
      selectedLogicalId?: string;
    };
    reasoning?: {
      requested?: { sourceEffort?: string; intent?: string };
      canonicalIntent?: string;
      mappingKind?: string;
    };
  }[];
};

async function readTraces(token: string): Promise<TraceShape["traces"]> {
  const listed = await requireApp().inject({
    method: "GET",
    url: "/v1/route-traces",
    headers: { authorization: `Bearer ${token}` },
  });
  const body: unknown = listed.json();
  const parsed = body && typeof body === "object" && "traces" in body ? body as TraceShape : { traces: [] };
  return parsed.traces;
}

const TERRA = "gpt-5.6-terra";
const SOL = "gpt-5.6-sol";

describe("Claude Code subagent model resolution (#71)", () => {
  it("routes a subagent fable request to the parent-family target and leaves the parent unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-subagent-"));
    directories.push(directory);
    const received: { model?: string }[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown };
      if (typeof body.model === "string") received.push({ model: body.model });
      return new Response(sseFixture("subagent-main", "SUBAGENT_OK"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await openApp(directory, endpoint, { primary: TERRA });
    const token = await issueToken();

    // Parent/main session runs Terra.
    const main = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...agentHeaders("session-1", "main") },
      payload: { model: "primary", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(main.statusCode).toBe(200);
    expect(received.at(-1)?.model).toBe(TERRA);

    // Kongming subagent requests `fable` with parent attribution → Sol.
    const kongming = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...agentHeaders("session-1", "kongming", "main") },
      payload: { model: "fable", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(kongming.statusCode).toBe(200);
    expect(received.at(-1)?.model).toBe(SOL);

    const tracesAfterKongming = await readTraces(token);
    const linkage = tracesAfterKongming.at(-1)?.agentLinkage;
    expect(linkage?.contextSource).toBe("parent-agent");
    expect(linkage?.parentModelId).toBe(TERRA);
    expect(linkage?.parentModelFamily).toBe("openai/codex");
    expect(linkage?.parentAgentPseudonym).toBeDefined();
    expect(linkage?.claudeSessionPseudonym).toMatch(/^[0-9a-f]{16}$/);
    expect(tracesAfterKongming.at(-1)?.tierResolution).toMatchObject({
      requestedTier: "fable",
      accessProviderId: "cline",
      modelFamily: "openai/codex",
      parentModelId: TERRA,
      selectedLogicalId: `cline/${SOL}`,
    });

    // Parent remains Terra after the subagent completes.
    const again = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...agentHeaders("session-1", "main") },
      payload: { model: "primary", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture-2" }] },
    });
    expect(again.statusCode).toBe(200);
    expect(received.at(-1)?.model).toBe(TERRA);

    // Secret-free: no prompts, credentials, or raw attribution ids in traces.
    const raw = JSON.stringify(await readTraces(token));
    expect(raw).not.toMatch(/kongming|session-1|main|cline-access-token-fixture|refresh-token|authorization|prompt|@/i);
  });

  it("resolves a low-tier reviewer independently via an explicit tier override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-subagent-haiku-"));
    directories.push(directory);
    const received: { model?: string }[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown };
      if (typeof body.model === "string") received.push({ model: body.model });
      return new Response(sseFixture("subagent-haiku", "SUBAGENT_HAIKU_OK"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    // Terra-class main model; haiku tier pinned to the family's lower-cost
    // target through the per-profile tier override (#69 user mapping).
    await openApp(directory, endpoint, { primary: TERRA, haiku: TERRA });
    const token = await issueToken();

    const reviewer = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...agentHeaders("session-2", "reviewer", "main") },
      payload: { model: "haiku", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(reviewer.statusCode).toBe(200);
    expect(received.at(-1)?.model).toBe(TERRA);

    // Kongming and the reviewer coexist under one launch session; neither
    // changes the other's mapping.
    const kongming = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...agentHeaders("session-2", "kongming", "main") },
      payload: { model: "fable", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(kongming.statusCode).toBe(200);
    expect(received.at(-1)?.model).toBe(SOL);

    const traces = await readTraces(token);
    expect(traces.at(-2)?.tierResolution?.requestedTier).toBe("haiku");
    expect(traces.at(-2)?.tierResolution?.selectedLogicalId).toBe(`cline/${TERRA}`);
    expect(traces.at(-2)?.tierResolution?.mappingSource).toBe("user-override");
    expect(traces.at(-1)?.tierResolution?.requestedTier).toBe("fable");
    expect(traces.at(-1)?.tierResolution?.selectedLogicalId).toBe(`cline/${SOL}`);
  });

  it("passes explicit subagent effort through #70 and rejects tool use without reasoning-with-tools evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-subagent-effort-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(sseFixture("subagent-effort", "SUBAGENT_EFFORT_OK"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await openApp(directory, endpoint, { primary: TERRA });
    const token = await issueToken();

    // Explicit effort (no tools) is preserved into the canonical reasoning
    // request and the translated trace.
    const effort = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...agentHeaders("session-3", "deep", "main") },
      payload: { model: "fable", max_tokens: 8, stream: true, effort: "high", messages: [{ role: "user", content: "fixture" }] },
    });
    expect(effort.statusCode).toBe(200);
    const traces = await readTraces(token);
    expect(traces.at(-1)?.reasoning?.requested?.sourceEffort).toBe("high");
    expect(traces.at(-1)?.reasoning?.requested?.intent).toBe("DEEP");
    expect(traces.at(-1)?.reasoning?.canonicalIntent).toBe("DEEP");

    // A tool-using subagent with explicit effort demands reasoning-with-tools
    // evidence; the frozen cline-family targets do not have it, so the request
    // fails closed with an actionable cause — never a silent downgrade.
    const tools = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...agentHeaders("session-3", "toolsub", "main") },
      payload: {
        model: "fable",
        max_tokens: 8,
        stream: true,
        effort: "high",
        tools: [{ name: "Bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
        messages: [{ role: "user", content: "fixture" }],
      },
    });
    expect(tools.statusCode).toBe(400);
    const body: { error?: { type?: string; reason?: string; cause?: string } } = tools.json();
    expect(body.error?.type).toBe("tier-unavailable");
    expect(body.error?.reason).toBe("mapping-invalid");
    expect(body.error?.cause).toBe("reasoning-unsupported");
  });

  it("keeps parallel subagents with different tiers independent and cleans up on lease revocation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-subagent-parallel-"));
    directories.push(directory);
    const received: { model?: string; agent?: string }[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown };
      received.push({
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        ...(typeof request.headers["x-claude-code-agent-id"] === "string" ? { agent: request.headers["x-claude-code-agent-id"] } : {}),
      });
      return new Response(sseFixture("subagent-parallel", "SUBAGENT_PARALLEL_OK"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await openApp(directory, endpoint, { primary: TERRA, haiku: TERRA });
    const token = await issueToken();

    const responses = await Promise.all([
      requireApp().inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...agentHeaders("session-4", "kongming", "main") },
        payload: { model: "fable", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
      }),
      requireApp().inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...agentHeaders("session-4", "reviewer", "main") },
        payload: { model: "haiku", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
      }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    // Kongming resolves to the Sol-class fable target while the reviewer
    // resolves to the Terra-class haiku target, independently, under one
    // launch session.
    expect(received.map((item) => item.model).sort()).toEqual([SOL, TERRA].sort());

    if (!agentContexts) throw new Error("missing agentContexts");
    expect(agentContexts.size()).toBe(2);
    // Lease revocation removes every agent context; stale ids cannot bind a
    // future session.
    if (!leases) throw new Error("missing leases");
    leases.dispose();
    await requireApp().inject({
      method: "DELETE",
      url: "/leases/00000000-0000-4000-8000-000000000411",
      headers: { authorization: "Bearer instance-secret" },
    });
    expect(agentContexts.size()).toBe(0);
  });

  it("fails closed when no parent model family can be determined", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-subagent-ambiguous-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(sseFixture("subagent-ambiguous", "SHOULD_NOT_RUN"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    // Multi-family ClinePass provider with no default parent model (only an
    // unreviewed pin) and no recorded parent context: `fable` cannot be scoped
    // to a family, so RLY fails closed (`family-unknown` → `tier-unavailable`)
    // instead of choosing a global strongest model or leaking another
    // subagent's context.
    await openApp(directory, endpoint, { primary: "gpt-unreviewed" });
    const token = await issueToken();

    const subagent = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...agentHeaders("session-5", "kongming", "main") },
      payload: { model: "fable", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(subagent.statusCode).toBe(400);
    const body: { error?: { type?: string; reason?: string; cause?: string } } = subagent.json();
    expect(body.error?.type).toBe("tier-unavailable");
    expect(body.error?.reason).toBe("tier-unavailable");
    // The actionable family-scoping detail rides the additive cause field.
    expect(body.error?.cause).toBe("family-unknown");
  });

  it("falls back to the profile default parent when the subagent parent is not yet recorded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-subagent-fallback-"));
    directories.push(directory);
    const received: { model?: string }[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown };
      if (typeof body.model === "string") received.push({ model: body.model });
      return new Response(sseFixture("subagent-fallback", "SUBAGENT_FALLBACK_OK"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await openApp(directory, endpoint, { primary: TERRA });
    const token = await issueToken();

    // Claude Code may spawn a subagent before the parent sent any gateway
    // request. The launch session's default context (profile main model) is
    // unambiguous, so `fable` still resolves inside the OpenAI/Codex family.
    const spawned = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...agentHeaders("session-6", "kongming", "main") },
      payload: { model: "fable", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(spawned.statusCode).toBe(200);
    expect(received.at(-1)?.model).toBe(SOL);
    const trace = (await readTraces(token)).at(-1);
    expect(trace?.agentLinkage?.contextSource).toBe("profile-default");
    expect(trace?.tierResolution?.parentModelId).toBe(TERRA);
  });
});
