import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createGatewayServer, createIdentityProof } from "../../src/runtime/gateway-server.js";

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe("gateway server", () => {
  it("exposes minimal liveness and protects readiness/identity", async () => {
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17871,
      authToken: "test-only-token",
      instanceId: "00000000-0000-4000-8000-000000000001",
      configFingerprint: "a".repeat(64),
    });

    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });

    const unauthorized = await app.inject({ method: "GET", url: "/readyz" });
    expect(unauthorized.statusCode).toBe(401);

    const malformed = await app.inject({
      method: "GET",
      url: "/identity",
    });
    expect(malformed.statusCode).toBe(400);

    const ready = await app.inject({
      method: "GET",
      url: "/readyz",
      headers: { authorization: "Bearer test-only-token" },
    });
    expect(ready.json()).toEqual({ ready: true, routes: 0 });

    const identity = await app.inject({
      method: "GET",
      url: `/identity?challenge=${"a".repeat(32)}`,
    });
    expect(identity.json()).toMatchObject({
      product: "rly-gateway",
      protocolVersion: 1,
      runtimeVersion: "0.1.0",
      proof: createIdentityProof(
        "test-only-token",
        "a".repeat(32),
        "00000000-0000-4000-8000-000000000001",
        "a".repeat(64),
      ),
    });
  });

  it("advertises resident ownership in the identity handshake", async () => {
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17871,
      authToken: "test-only-token",
      instanceId: "00000000-0000-4000-8000-000000000002",
      configFingerprint: "a".repeat(64),
      resident: true,
    });
    const identity = await app.inject({
      method: "GET",
      url: `/identity?challenge=${"b".repeat(32)}`,
    });
    expect(identity.json()).toMatchObject({ resident: true, runtimeVersion: "0.1.0" });
  });

  it("rejects unauthenticated shutdown and exposes shutdown only when wired", async () => {
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17871,
      authToken: "test-only-token",
      instanceId: "00000000-0000-4000-8000-000000000001",
      configFingerprint: "a".repeat(64),
    });
    const unauthorized = await app.inject({ method: "POST", url: "/shutdown" });
    expect(unauthorized.statusCode).toBe(401);
    const unavailable = await app.inject({
      method: "POST",
      url: "/shutdown",
      headers: { authorization: "Bearer test-only-token" },
    });
    expect(unavailable.statusCode).toBe(503);
  });

  it("triggers the wired shutdown after replying 202", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17871,
      authToken: "test-only-token",
      instanceId: "00000000-0000-4000-8000-000000000001",
      configFingerprint: "a".repeat(64),
      shutdown,
    });
    const response = await app.inject({
      method: "POST",
      url: "/shutdown",
      headers: { authorization: "Bearer test-only-token" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ shuttingDown: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("mounts configured provider routes behind the transient gateway token", async () => {
    app = createGatewayServer({
      host: "127.0.0.1", port: 17871, authToken: "test-only-token", instanceId: "00000000-0000-4000-8000-000000000001", configFingerprint: "a".repeat(64),
      config: { schemaVersion: 1, gateway: { host: "127.0.0.1", port: 17871, managementPort: 17872, logLevel: "silent" }, controlPlane: {}, routes: { primary: { provider: "openrouter", model: "nvidia/nemotron-3.5-lightning:free", credential: "env:OPENROUTER_API_KEY" } } },
    });
    const blocked = await app.inject({ method: "POST", url: "/v1/messages", payload: { model: "primary", max_tokens: 1, messages: [{ role: "user", content: "fixture" }] } });
    expect(blocked.statusCode).toBe(401);
    const countBlocked = await app.inject({ method: "POST", url: "/v1/messages/count_tokens", payload: { model: "primary", max_tokens: 1, messages: [{ role: "user", content: "fixture" }] } });
    expect(countBlocked.statusCode).toBe(401);
    const xApiKey = await app.inject({ method: "POST", url: "/v1/messages/count_tokens", headers: { "x-api-key": "test-only-token" }, payload: { model: "primary", max_tokens: 1, messages: [{ role: "user", content: "fixture" }] } });
    expect(xApiKey.statusCode).toBe(200);
    expect(xApiKey.headers["x-rly-gateway-token-count-quality"]).toBe("conservative-estimate");
    const ready = await app.inject({ method: "GET", url: "/readyz", headers: { authorization: "Bearer test-only-token" } });
    expect(ready.json()).toEqual({ ready: true, routes: 1 });
  });
});
