import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { createManagementServer, listenManagement, type ManagementServerOptions } from "../../src/management/server.js";
import { SessionStore } from "../../src/management/session-store.js";
import { RouteTraceRing } from "../../src/profiles/traces.js";

const PROTECTED_PORTS = new Set([10100, 8317, 17870]);

export type ManagementBrowserSession = Readonly<{
  origin: string;
  token: string;
  stop: () => Promise<void>;
}>;

async function bindEphemeralPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (address === null || typeof address === "string") {
          reject(new Error("expected a TCP address"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function allocateLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await bindEphemeralPort();
    if (!PROTECTED_PORTS.has(port)) return port;
  }
  throw new Error("could not allocate a non-protected loopback port");
}

export async function startManagementBrowser(): Promise<ManagementBrowserSession> {
  const directory = await mkdtemp(join(tmpdir(), "agent-gateway-browser-"));
  const port = await allocateLoopbackPort();
  const store = await ControlPlaneStore.open(directory);
  const sessions = new SessionStore();
  const traces = new RouteTraceRing();
  traces.push({
    requestId: "req-browser-fixture",
    policyRevision: 1,
    policyHash: "a".repeat(64),
    strategy: "manual",
    sourceRule: "profile",
    candidates: [{ accountPseudonym: "acct-fixture-001", eligible: true, reasons: [] }],
    selected: { accountPseudonym: "acct-fixture-001", credentialGeneration: 1 },
    decidedAt: "2026-08-14T00:00:00.000Z",
  }, "work");
  const origin = `http://127.0.0.1:${String(port)}`;
  const options: ManagementServerOptions = {
    host: "127.0.0.1",
    port,
    origin,
    managementToken: "mgmt-fixture",
    instanceId: "00000000-0000-4000-8000-000000000019",
    configFingerprint: "a".repeat(64),
    store,
    sessions,
    traces,
  };
  const app: FastifyInstance = createManagementServer(options);
  await listenManagement(app, options);
  const issued = sessions.issueBootstrap();
  return {
    origin,
    token: issued.token,
    stop: async () => {
      await app.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
