import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { bootstrapPageHtml, SESSION_COOKIE_NAME } from "../../src/management/bootstrap-page.js";
import { createManagementIdentityProof, createManagementServer } from "../../src/management/server.js";
import { SessionStore } from "../../src/management/session-store.js";

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

async function start(clock: () => Date = () => new Date()) {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-mgmt-"));
  directories.push(directory);
  store = await ControlPlaneStore.open(directory, { clock });
  const sessions = new SessionStore(clock);
  app = createManagementServer({
    host: "127.0.0.1",
    port: 17872,
    origin: "http://127.0.0.1:17872",
    managementToken: "mgmt-secret",
    instanceId: "00000000-0000-4000-8000-000000000099",
    configFingerprint: "a".repeat(64),
    store,
    sessions,
  });
  return { sessions };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return value as Record<string, unknown>;
}

describe("management authentication", () => {
  it("accepts the instance bearer and rejects the wrong secret", async () => {
    await start();
    if (!app) throw new Error("missing app");
    const allowed = await app.inject({
      method: "GET",
      url: "/readyz",
      headers: { authorization: "Bearer mgmt-secret" },
    });
    expect(allowed.statusCode).toBe(200);
    const denied = await app.inject({
      method: "GET",
      url: "/readyz",
      headers: { authorization: "Bearer other-secret" },
    });
    expect(denied.statusCode).toBe(401);
  });

  it("exchanges a single-use bootstrap token for an HttpOnly SameSite=Strict cookie", async () => {
    const { sessions } = await start();
    if (!app) throw new Error("missing app");
    const issued = sessions.issueBootstrap();
    const first = await app.inject({
      method: "POST",
      url: "/auth/exchange",
      headers: { origin: "http://127.0.0.1:17872", "content-type": "application/json" },
      payload: { token: issued.token },
    });
    expect(first.statusCode).toBe(200);
    expect(typeof asRecord(first.json())["csrfToken"]).toBe("string");
    expect(first.headers["set-cookie"]).toEqual(expect.stringContaining("HttpOnly"));
    expect(first.headers["set-cookie"]).toEqual(expect.stringContaining("SameSite=Strict"));
    expect(first.headers["set-cookie"]).toEqual(expect.stringContaining(`${SESSION_COOKIE_NAME}=`));
    const replay = await app.inject({
      method: "POST",
      url: "/auth/exchange",
      headers: { origin: "http://127.0.0.1:17872", "content-type": "application/json" },
      payload: { token: issued.token },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("rejects expired bootstrap tokens and cross-origin mutations", async () => {
    let now = new Date("2026-08-13T00:00:00.000Z");
    const { sessions } = await start(() => now);
    if (!app) throw new Error("missing app");
    const issued = sessions.issueBootstrap();
    now = new Date(now.getTime() + 61_000);
    const expired = await app.inject({
      method: "POST",
      url: "/auth/exchange",
      headers: { origin: "http://127.0.0.1:17872", "content-type": "application/json" },
      payload: { token: issued.token },
    });
    expect(expired.statusCode).toBe(401);
    const cross = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: {
        authorization: "Bearer mgmt-secret",
        origin: "http://evil.example",
        "content-type": "application/json",
      },
      payload: { name: "blocked", integrationMode: "direct" },
    });
    expect(cross.statusCode).toBe(403);
    expect(store?.listProviders()).toEqual([]);
  });

  it("rejects invalid CSRF and logout/shutdown session reuse", async () => {
    const { sessions } = await start();
    if (!app) throw new Error("missing app");
    const issued = sessions.issueBootstrap();
    const exchanged = await app.inject({
      method: "POST",
      url: "/auth/exchange",
      headers: { origin: "http://127.0.0.1:17872", "content-type": "application/json" },
      payload: { token: issued.token },
    });
    const cookie = String(exchanged.headers["set-cookie"]).split(";")[0];
    const csrf = String(asRecord(exchanged.json())["csrfToken"]);
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: {
        origin: "http://127.0.0.1:17872",
        cookie,
        "x-csrf-token": "wrong-csrf-token-value",
        "content-type": "application/json",
      },
      payload: { name: "blocked", integrationMode: "direct" },
    });
    expect(invalid.statusCode).toBe(403);
    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { origin: "http://127.0.0.1:17872", cookie, "x-csrf-token": csrf },
    });
    expect(logout.statusCode).toBe(200);
    const reused = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: {
        origin: "http://127.0.0.1:17872",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { name: "blocked", integrationMode: "direct" },
    });
    expect(reused.statusCode).toBe(401);
    sessions.revokeAll();
    const afterShutdown = await app.inject({
      method: "GET",
      url: "/readyz",
      headers: { cookie },
    });
    expect(afterShutdown.statusCode).toBe(401);
  });

  it("proves management identity without exposing the instance secret", async () => {
    await start();
    if (!app) throw new Error("missing app");
    const challenge = "b".repeat(32);
    const identity = await app.inject({ method: "GET", url: `/identity?challenge=${challenge}` });
    expect(identity.json()).toMatchObject({
      product: "rly-gateway-management",
      proof: createManagementIdentityProof(
        "mgmt-secret",
        challenge,
        "00000000-0000-4000-8000-000000000099",
        "a".repeat(64),
      ),
    });
    expect(JSON.stringify(identity.json())).not.toContain("mgmt-secret");
  });

  it("keeps the bootstrap token in the fragment and removes it from history in the page script", () => {
    const html = bootstrapPageHtml();
    expect(html).toContain('history.replaceState');
    expect(html).toContain("/auth/exchange");
    expect(html).toContain('referrerPolicy: "no-referrer"');
    expect(html).toContain('params.get("t")');
    expect(html).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/);
  });
});
