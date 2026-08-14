import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  CLINE_FIXTURE_ACCESS_A,
  CLINE_FIXTURE_ACCESS_B,
  CLINE_FIXTURE_REFRESH_A,
  CLINE_FIXTURE_REFRESH_B,
  CLINE_PRIMARY_MODEL,
  seedClineClaudeProfile,
  seedCodexCredentialFile,
  sseFixture,
} from "../helpers/cline-profile-seed.js";

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
  await seedClineClaudeProfile(store, broker, directory, { endpoint });
  leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
  const sessions = new LaunchSessionRegistry((id) => leases?.has(id) === true);
  const traces = new RouteTraceRing();
  const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17891, logLevel: "silent" } });
  app = createGatewayServer({
    host: "127.0.0.1",
    port: 17891,
    authToken: "instance-secret",
    instanceId: "00000000-0000-4000-8000-000000000301",
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

async function issueToken(profileName = "clinepass"): Promise<string> {
  const leaseId = "00000000-0000-4000-8000-000000000311";
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

describe("clinepass profile pool route", () => {
  it("maps Claude helpers onto Cline evidence, streams, and rejects unknown capability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cline-profile-"));
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
      return new Response(sseFixture("cline-helper", "CLINE_HELPER_OK"), {
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
    expect(helper.body).toContain("CLINE_HELPER_OK");
    expect(received[0]?.model).toBe(CLINE_PRIMARY_MODEL);
    expect(received[0]?.stream).toBe(true);
    expect(received[0]?.authorization).toBe(`Bearer ${CLINE_FIXTURE_ACCESS_A}`);

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
    expect(tools.body).toContain("CLINE_HELPER_OK");

    const listed = await requireApp().inject({
      method: "GET",
      url: "/v1/route-traces",
      headers: { authorization: `Bearer ${token}` },
    });
    const listedBody: unknown = listed.json();
    const body = listedBody && typeof listedBody === "object" && "traces" in listedBody
      ? listedBody as { traces: { profileName?: string; sourceRule?: string; selected?: { accountPseudonym?: string } }[] }
      : { traces: [] };
    expect(body.traces[0]?.profileName).toBe("clinepass");
    expect(body.traces[0]?.sourceRule).toMatch(/^pool:/);
    expect(body.traces[0]?.selected?.accountPseudonym).toBe("acct-cline-a");
    expect(JSON.stringify(body)).not.toMatch(/cline-access-token-fixture|refresh-token|authorization|prompt|@/i);
    expect(traces.list("clinepass")[0]?.sourceRule).toMatch(/^pool:/);

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
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cline-quota-"));
    directories.push(directory);
    const seen: string[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request, reply) => {
      const authorization = headerValue(request.headers.authorization);
      seen.push(authorization);
      if (authorization.includes(CLINE_FIXTURE_ACCESS_A)) {
        return reply.code(429).send({ error: { message: "quota" } });
      }
      return new Response(sseFixture("cline-quota", "CLINE_ROTATED_OK"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    store = await ControlPlaneStore.open(directory);
    broker = await CredentialBroker.open(directory);
    await seedClineClaudeProfile(store, broker, directory, {
      endpoint,
      retryBudget: 1,
      strategy: "fill-first",
      accounts: [
        { pseudonym: "acct-cline-a", access: CLINE_FIXTURE_ACCESS_A, refresh: CLINE_FIXTURE_REFRESH_A },
        { pseudonym: "acct-cline-b", access: CLINE_FIXTURE_ACCESS_B, refresh: CLINE_FIXTURE_REFRESH_B },
      ],
    });
    leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17891,
      authToken: "instance-secret",
      instanceId: "00000000-0000-4000-8000-000000000302",
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
    expect(response.body).toContain("CLINE_ROTATED_OK");
    expect(seen.some((item) => item.includes(CLINE_FIXTURE_ACCESS_A))).toBe(true);
    expect(seen.some((item) => item.includes(CLINE_FIXTURE_ACCESS_B))).toBe(true);
    const first = store.listAccounts().find((account) => account.pseudonym === "acct-cline-a");
    const second = store.listAccounts().find((account) => account.pseudonym === "acct-cline-b");
    expect(first?.quotaClass).toBe("exhausted");
    expect(second?.quotaClass).toBe("healthy");
  });

  it("keeps a sticky session on the same Cline account", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cline-sticky-"));
    directories.push(directory);
    const seen: string[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      seen.push(headerValue(request.headers.authorization));
      return new Response(sseFixture("cline-sticky", "CLINE_STICKY_OK"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    store = await ControlPlaneStore.open(directory);
    broker = await CredentialBroker.open(directory);
    await seedClineClaudeProfile(store, broker, directory, {
      endpoint,
      strategy: "round-robin",
      retryBudget: 0,
      affinity: { sessionAffinity: { enabled: true, ttlSeconds: 60 } },
      accounts: [
        { pseudonym: "acct-cline-a", access: CLINE_FIXTURE_ACCESS_A, refresh: CLINE_FIXTURE_REFRESH_A },
        { pseudonym: "acct-cline-b", access: CLINE_FIXTURE_ACCESS_B, refresh: CLINE_FIXTURE_REFRESH_B },
      ],
    });
    leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
    const traces = new RouteTraceRing();
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17891,
      authToken: "instance-secret",
      instanceId: "00000000-0000-4000-8000-000000000303",
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
    const decisions = traces.list("clinepass");
    expect(decisions[1]?.sourceRule).toMatch(/affinity/);
    expect(decisions[0]?.selected?.accountPseudonym).toBe(decisions[1]?.selected?.accountPseudonym);
  });

  it("fails closed when Cline roles lack exact registry evidence or would use another provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cline-evidence-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(sseFixture("cline-miss", "SHOULD_NOT_RUN"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    store = await ControlPlaneStore.open(directory);
    broker = await CredentialBroker.open(directory);
    await seedClineClaudeProfile(store, broker, directory, {
      endpoint,
      modelRoles: { primary: "gpt-5.4", fast: "gpt-unreviewed" },
    });
    leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17891,
      authToken: "instance-secret",
      instanceId: "00000000-0000-4000-8000-000000000304",
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

  it("does not mutate Codex credential files when a Cline upstream request fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cline-fail-iso-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 }));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    store = await ControlPlaneStore.open(directory);
    broker = await CredentialBroker.open(directory);
    const sentinel = await seedCodexCredentialFile(broker, directory);
    const before = await readFile(sentinel.activePath);
    await seedClineClaudeProfile(store, broker, directory, { endpoint, retryBudget: 0 });
    leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17891,
      authToken: "instance-secret",
      instanceId: "00000000-0000-4000-8000-000000000305",
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
    const failed = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: "primary", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(failed.statusCode).toBe(401);
    expect(JSON.stringify(failed.json())).toContain("authentication_error");
    expect(await readFile(sentinel.activePath)).toEqual(before);
    const still = await broker.metadata(sentinel.handle);
    expect(still?.generation).toBe(1);
    expect(still?.provider).toBe("codex");
  });
});
