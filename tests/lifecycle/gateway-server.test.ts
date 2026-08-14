import { afterEach, describe, expect, it } from "vitest";
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
      product: "agent-gateway",
      protocolVersion: 1,
      proof: createIdentityProof(
        "test-only-token",
        "a".repeat(32),
        "00000000-0000-4000-8000-000000000001",
        "a".repeat(64),
      ),
    });
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
    expect(xApiKey.headers["x-agent-gateway-token-count-quality"]).toBe("conservative-estimate");
    const ready = await app.inject({ method: "GET", url: "/readyz", headers: { authorization: "Bearer test-only-token" } });
    expect(ready.json()).toEqual({ ready: true, routes: 1 });
  });
});
