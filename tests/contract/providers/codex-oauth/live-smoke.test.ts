import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../../../../src/control-plane/store.js";
import { CredentialBroker } from "../../../../src/credentials/broker.js";
import { LaunchSessionRegistry } from "../../../../src/profiles/sessions.js";
import { RouteTraceRing } from "../../../../src/profiles/traces.js";
import { createGatewayServer } from "../../../../src/runtime/gateway-server.js";
import { AffinityStore } from "../../../../src/routing/pools/affinity.js";
import { RouteSelector } from "../../../../src/routing/pools/selector.js";
import { gatewayConfigSchema } from "../../../../src/config/schema.js";

const enabled = process.env["AGENT_GATEWAY_LIVE_CODEX_OAUTH"] === "1";
const handle = process.env["AGENT_GATEWAY_LIVE_CODEX_HANDLE"];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.skipIf(!enabled || !handle)("Codex OAuth live pool smoke", () => {
  it("issues one profile-scoped request through the pool and records only secret-free evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-gateway-codex-pool-smoke-"));
    directories.push(directory);
    const store = await ControlPlaneStore.open(directory);
    const broker = await CredentialBroker.open(directory);
    try {
      const metadata = await broker.metadata(handle ?? "");
      expect(metadata, "live handle must resolve to project-owned metadata").toBeDefined();
      const provider = store.createProvider({ name: "codex", integrationMode: "oauth" }, "cli");
      const account = store.createAccount({
        pseudonym: "acct-live",
        providerId: provider.id,
        credentialHandle: handle ?? "",
      }, "cli");
      const ready = store.bindCredential(account.id, account.version, {
        credentialHandle: handle ?? "",
        credentialGeneration: metadata?.generation ?? 1,
        state: "ready",
      }, "cli");
      const pool = store.createPool({
        name: "live-pool",
        providerId: provider.id,
        strategy: "fill-first",
        retryBudget: 0,
        accountIds: [ready.id],
      }, "cli");
      store.createProfile({
        name: "codex",
        harness: "claude",
        providerId: provider.id,
        poolId: pool.id,
        modelRoles: { primary: "gpt-5.4" },
      }, "cli");
      const sessions = new LaunchSessionRegistry();
      const traces = new RouteTraceRing();
      const app = createGatewayServer({
        host: "127.0.0.1",
        port: 17871,
        authToken: "live-instance",
        instanceId: "00000000-0000-4000-8000-000000000099",
        configFingerprint: "b".repeat(64),
        config: gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17871, logLevel: "silent" } }),
        controlPlane: store,
        broker,
        selector: new RouteSelector(store, new AffinityStore(directory)),
        launchSessions: sessions,
        traces,
      });
      const issued = await app.inject({
        method: "POST",
        url: "/v1/launch-sessions",
        headers: { authorization: "Bearer live-instance", "content-type": "application/json" },
        payload: { profileName: "codex", leaseId: "00000000-0000-4000-8000-000000000011" },
      });
      expect(issued.statusCode).toBe(201);
      const issuedBody: unknown = issued.json();
      const token = issuedBody && typeof issuedBody === "object" && "token" in issuedBody && typeof issuedBody.token === "string"
        ? issuedBody.token
        : "";
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { model: "primary", max_tokens: 16, messages: [{ role: "user", content: "Reply with one word." }] },
      });
      expect(response.statusCode).toBeLessThan(500);
      const listed = await app.inject({
        method: "GET",
        url: "/v1/route-traces",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(JSON.stringify(listed.json())).not.toMatch(/accessToken|refreshToken|authorization|sk-|Bearer /i);
      await app.close();
    } finally {
      await broker.close();
      store.close();
    }
  });
});
