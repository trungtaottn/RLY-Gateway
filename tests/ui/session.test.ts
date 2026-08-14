import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { createManagementServer } from "../../src/management/server.js";
import { SessionStore } from "../../src/management/session-store.js";
import { RouteTraceRing } from "../../src/profiles/traces.js";
import { MANAGEMENT_SECURITY_HEADERS } from "../../src/management/security-headers.js";

const directories: string[] = [];
let app: FastifyInstance | undefined;
let store: ControlPlaneStore | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  store?.close();
  store = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function start() {
  const directory = await mkdtemp(join(tmpdir(), "agent-gateway-ui-"));
  directories.push(directory);
  store = await ControlPlaneStore.open(directory);
  const sessions = new SessionStore();
  const traces = new RouteTraceRing();
  traces.push({
    requestId: "req-fixture",
    policyRevision: 1,
    policyHash: "a".repeat(64),
    strategy: "manual",
    sourceRule: "profile",
    candidates: [{ accountPseudonym: "acct-fixture-001", eligible: true, reasons: [] }],
    selected: { accountPseudonym: "acct-fixture-001", credentialGeneration: 1 },
    decidedAt: "2026-08-14T00:00:00.000Z",
  }, "work");
  app = createManagementServer({
    host: "127.0.0.1",
    port: 17872,
    origin: "http://127.0.0.1:17872",
    managementToken: "mgmt-secret",
    instanceId: "00000000-0000-4000-8000-000000000099",
    configFingerprint: "a".repeat(64),
    store,
    sessions,
    traces,
  });
  return { sessions };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return value as Record<string, unknown>;
}

describe("management UI session and diagnostics", () => {
  it("rotates CSRF on resume and never returns secrets on health or traces", async () => {
    const { sessions } = await start();
    if (!app || !store) throw new Error("missing app");
    const issued = sessions.issueBootstrap();
    const exchanged = await app.inject({
      method: "POST",
      url: "/auth/exchange",
      headers: { origin: "http://127.0.0.1:17872", "content-type": "application/json" },
      payload: { token: issued.token },
    });
    const cookie = String(exchanged.headers["set-cookie"]).split(";")[0];
    const firstCsrf = String(asRecord(exchanged.json())["csrfToken"]);
    const resumed = await app.inject({
      method: "POST",
      url: "/auth/resume",
      headers: { origin: "http://127.0.0.1:17872", cookie, "content-type": "application/json" },
      payload: {},
    });
    expect(resumed.statusCode).toBe(200);
    const nextCsrf = String(asRecord(resumed.json())["csrfToken"]);
    expect(nextCsrf).not.toBe(firstCsrf);
    expect(JSON.stringify(resumed.json())).not.toMatch(/accessToken|refreshToken|email/i);
    const stale = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: {
        origin: "http://127.0.0.1:17872",
        cookie,
        "x-csrf-token": firstCsrf,
        "content-type": "application/json",
      },
      payload: { name: "blocked", integrationMode: "direct" },
    });
    expect(stale.statusCode).toBe(403);
    const created = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: {
        origin: "http://127.0.0.1:17872",
        cookie,
        "x-csrf-token": nextCsrf,
        "content-type": "application/json",
      },
      payload: { name: "gemini", integrationMode: "oauth" },
    });
    expect(created.statusCode).toBe(201);
    const health = await app.inject({ method: "GET", url: "/v1/health", headers: { cookie } });
    const traces = await app.inject({ method: "GET", url: "/v1/route-traces", headers: { cookie } });
    expect(health.statusCode).toBe(200);
    expect(traces.statusCode).toBe(200);
    expect(JSON.stringify(traces.json())).toContain("acct-fixture-001");
    expect(JSON.stringify(traces.json())).not.toMatch(/accessToken|refreshToken|authorization/i);
    for (const [name, value] of Object.entries(MANAGEMENT_SECURITY_HEADERS)) {
      expect(String(created.headers[name])).toBe(value);
    }
  });
});
