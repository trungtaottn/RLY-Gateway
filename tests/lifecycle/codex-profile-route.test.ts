import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { LaunchSessionRegistry } from "../../src/profiles/sessions.js";
import { RouteTraceRing } from "../../src/profiles/traces.js";
import { createGatewayServer } from "../../src/runtime/gateway-server.js";
import { LeaseManager } from "../../src/runtime/lease-manager.js";
import { AffinityStore } from "../../src/routing/pools/affinity.js";
import { RouteSelector } from "../../src/routing/pools/selector.js";
import { gatewayConfigSchema } from "../../src/config/schema.js";
import {
  CODEX_PRIMARY_MODEL,
  FIXTURE_ACCESS_A,
  FIXTURE_ACCESS_B,
  FIXTURE_REFRESH_A,
  FIXTURE_REFRESH_B,
  seedCodexClaudeProfile,
  sseFixture,
} from "../helpers/codex-profile-seed.js";

const directories: string[] = [];
let app: FastifyInstance | undefined;
let store: ControlPlaneStore | undefined;
let broker: CredentialBroker | undefined;
let provider: FastifyInstance | undefined;
let leases: LeaseManager | undefined;

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
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function openApp(directory: string, endpoint: string) {
  store = await ControlPlaneStore.open(directory);
  broker = await CredentialBroker.open(directory);
  await seedCodexClaudeProfile(store, broker, directory, { endpoint });
  leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
  const sessions = new LaunchSessionRegistry((id) => leases?.has(id) === true);
  const traces = new RouteTraceRing();
  const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17891, logLevel: "silent" } });
  app = createGatewayServer({
    host: "127.0.0.1",
    port: 17891,
    authToken: "instance-secret",
    instanceId: "00000000-0000-4000-8000-000000000201",
    configFingerprint: "c".repeat(64),
    config,
    controlPlane: store,
    broker,
    selector: new RouteSelector(store, new AffinityStore(directory)),
    launchSessions: sessions,
    traces,
    leases,
  });
  return { traces };
}

function requireApp(): FastifyInstance {
  if (!app) throw new Error("missing gateway");
  return app;
}

function headerValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function issueToken(profileName = "codex"): Promise<string> {
  const leaseId = "00000000-0000-4000-8000-000000000211";
  if (!leases) throw new Error("missing leases");
  await leases.add(leaseId);
  const issued = await requireApp().inject({
    method: "POST",
    url: "/v1/launch-sessions",
    headers: { authorization: "Bearer instance-secret", "content-type": "application/json" },
    payload: { profileName, leaseId },
  });
  expect(issued.statusCode).toBe(201);
  const body: unknown = issued.json();
  const token = body && typeof body === "object" && "token" in body && typeof body.token === "string" ? body.token : "";
  expect(token).not.toBe("");
  return token;
}

describe("codex profile pool route", () => {
  it("maps Claude helpers onto Codex evidence, streams, and rejects unknown capability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-codex-profile-"));
    directories.push(directory);
    const received: { model?: string; stream?: unknown; authorization?: string }[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown; stream?: unknown };
      received.push({
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        stream: body.stream,
        authorization: headerValue(request.headers.authorization),
      });
      return new Response(sseFixture("codex-helper", "CODEX_HELPER_OK"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    const { traces } = await openApp(directory, endpoint);
    const token = await issueToken();
    const helper = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: "claude-haiku-4-5", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(helper.statusCode).toBe(200);
    expect(helper.body).toContain("CODEX_HELPER_OK");
    expect(received[0]?.model).toBe(CODEX_PRIMARY_MODEL);
    expect(received[0]?.stream).toBe(true);
    expect(received[0]?.authorization).toBe(`Bearer ${FIXTURE_ACCESS_A}`);

    const tools = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        model: "primary",
        max_tokens: 8,
        stream: true,
        tools: [{ name: "Bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
        messages: [{ role: "user", content: "fixture" }],
      },
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.body).toContain("CODEX_HELPER_OK");

    const listed = await requireApp().inject({
      method: "GET",
      url: "/v1/route-traces",
      headers: { authorization: `Bearer ${token}` },
    });
    const listedBody: unknown = listed.json();
    const body = listedBody && typeof listedBody === "object" && "traces" in listedBody
      ? listedBody as { traces: { profileName?: string; sourceRule?: string; selected?: { accountPseudonym?: string } }[] }
      : { traces: [] };
    expect(body.traces[0]?.profileName).toBe("codex");
    expect(body.traces[0]?.sourceRule).toMatch(/^pool:/);
    expect(body.traces[0]?.selected?.accountPseudonym).toBe("acct-codex-a");
    expect(JSON.stringify(body)).not.toMatch(/access-token-fixture|refresh-token|authorization|prompt|@/i);
    expect(traces.list("codex")[0]?.sourceRule).toMatch(/^pool:/);

    const images = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        model: "primary",
        max_tokens: 8,
        messages: [{
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }],
        }],
      },
    });
    expect(images.statusCode).toBe(400);
    expect(JSON.stringify(images.json())).toMatch(/capability-rejected|unsupported_feature/);
  });

  it("rotates on pre-output quota using the existing pool machinery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-codex-quota-"));
    directories.push(directory);
    const seen: string[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request, reply) => {
      const authorization = headerValue(request.headers.authorization);
      seen.push(authorization);
      if (authorization.includes(FIXTURE_ACCESS_A)) {
        return reply.code(429).send({ error: { message: "quota" } });
      }
      return new Response(sseFixture("codex-quota", "CODEX_ROTATED_OK"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    store = await ControlPlaneStore.open(directory);
    broker = await CredentialBroker.open(directory);
    await seedCodexClaudeProfile(store, broker, directory, {
      endpoint,
      retryBudget: 1,
      strategy: "fill-first",
      accounts: [
        { pseudonym: "acct-codex-a", access: FIXTURE_ACCESS_A, refresh: FIXTURE_REFRESH_A },
        { pseudonym: "acct-codex-b", access: FIXTURE_ACCESS_B, refresh: FIXTURE_REFRESH_B },
      ],
    });
    leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17891,
      authToken: "instance-secret",
      instanceId: "00000000-0000-4000-8000-000000000202",
      configFingerprint: "c".repeat(64),
      config: gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17891, logLevel: "silent" } }),
      controlPlane: store,
      broker,
      selector: new RouteSelector(store, new AffinityStore(directory)),
      launchSessions: new LaunchSessionRegistry((id) => leases?.has(id) === true),
      traces: new RouteTraceRing(),
      leases,
    });
    const token = await issueToken();
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: "primary", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("CODEX_ROTATED_OK");
    expect(seen.some((item) => item.includes(FIXTURE_ACCESS_A))).toBe(true);
    expect(seen.some((item) => item.includes(FIXTURE_ACCESS_B))).toBe(true);
    const first = store.listAccounts().find((account) => account.pseudonym === "acct-codex-a");
    const second = store.listAccounts().find((account) => account.pseudonym === "acct-codex-b");
    expect(first?.quotaClass).toBe("exhausted");
    expect(second?.quotaClass).toBe("healthy");
  });

  it("keeps a sticky session on the same Codex account", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-codex-sticky-"));
    directories.push(directory);
    const seen: string[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      seen.push(headerValue(request.headers.authorization));
      return new Response(sseFixture("codex-sticky", "CODEX_STICKY_OK"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    store = await ControlPlaneStore.open(directory);
    broker = await CredentialBroker.open(directory);
    await seedCodexClaudeProfile(store, broker, directory, {
      endpoint,
      strategy: "round-robin",
      retryBudget: 0,
      affinity: { sessionAffinity: { enabled: true, ttlSeconds: 60 } },
      accounts: [
        { pseudonym: "acct-codex-a", access: FIXTURE_ACCESS_A, refresh: FIXTURE_REFRESH_A },
        { pseudonym: "acct-codex-b", access: FIXTURE_ACCESS_B, refresh: FIXTURE_REFRESH_B },
      ],
    });
    leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
    const traces = new RouteTraceRing();
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17891,
      authToken: "instance-secret",
      instanceId: "00000000-0000-4000-8000-000000000203",
      configFingerprint: "c".repeat(64),
      config: gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17891, logLevel: "silent" } }),
      controlPlane: store,
      broker,
      selector: new RouteSelector(store, new AffinityStore(directory)),
      launchSessions: new LaunchSessionRegistry((id) => leases?.has(id) === true),
      traces,
      leases,
    });
    const token = await issueToken();
    const first = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: "primary", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture-1" }] },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: "primary", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture-2" }] },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    const decisions = traces.list("codex");
    expect(decisions[1]?.sourceRule).toMatch(/affinity/);
    expect(decisions[0]?.selected?.accountPseudonym).toBe(decisions[1]?.selected?.accountPseudonym);
  });

  it("fails closed when Codex roles lack exact registry evidence or would use another provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-codex-evidence-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(sseFixture("codex-miss", "SHOULD_NOT_RUN"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    store = await ControlPlaneStore.open(directory);
    broker = await CredentialBroker.open(directory);
    await seedCodexClaudeProfile(store, broker, directory, {
      endpoint,
      modelRoles: { primary: "nvidia/nemotron-3.5-lightning:free", fast: "gpt-unreviewed" },
    });
    leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17891,
      authToken: "instance-secret",
      instanceId: "00000000-0000-4000-8000-000000000204",
      configFingerprint: "c".repeat(64),
      config: gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17891, logLevel: "silent" } }),
      controlPlane: store,
      broker,
      selector: new RouteSelector(store, new AffinityStore(directory)),
      launchSessions: new LaunchSessionRegistry((id) => leases?.has(id) === true),
      traces: new RouteTraceRing(),
      leases,
    });
    const token = await issueToken();
    const remapped = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: "primary", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(remapped.statusCode).toBe(400);
    expect(JSON.stringify(remapped.json())).toContain("capability-rejected");
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: "fast", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(unknown.statusCode).toBe(400);
    expect(JSON.stringify(unknown.json())).toContain("capability-rejected");
  });
});
