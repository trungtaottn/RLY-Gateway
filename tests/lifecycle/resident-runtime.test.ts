import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayConfigSchema, type GatewayConfig } from "../../src/config/schema.js";
import { acquireGateway, inspectGateway, inspectRuntimeGateway } from "../../src/runtime/gateway-lifecycle.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import { startResidentRuntime, stopResidentRuntime } from "../../src/runtime/resident-runtime.js";
import { RuntimeStore } from "../../src/runtime/runtime-store.js";

const directories: string[] = [];
const servers: Server[] = [];

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function config(port: number, managementPort: number, model = "model"): GatewayConfig {
  return gatewayConfigSchema.parse({
    schemaVersion: 1,
    gateway: { host: "127.0.0.1", port, managementPort, logLevel: "silent" },
    routes: {
      primary: { provider: "openrouter", model, credential: "env:OPENROUTER_API_KEY" },
    },
  });
}

async function runtimeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-resident-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resident runtime", () => {
  it("stays alive after the last launcher lease is released", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const directory = await runtimeDirectory();
    const controlPlaneDirectory = await runtimeDirectory();
    const resident = await startResidentRuntime({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
      heartbeatMs: 5,
    });
    expect(resident.alreadyRunning).toBe(false);
    expect(resident.runtimeVersion).toBe(RUNTIME_VERSION);

    // A launcher reuses the same resident instance and releases its lease.
    const launcher = await acquireGateway({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
      heartbeatMs: 5,
    });
    expect(launcher.reused).toBe(true);
    expect(launcher.instanceId).toBe(resident.instanceId);
    await launcher.release();

    // Longer than the idle grace: idle shutdown must not fire while the
    // resident service owns its lease.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const state = await inspectRuntimeGateway(config(port, managementPort), directory);
    expect(state.state).toBe("attested-compatible");
    if (state.state === "attested-compatible") expect(state.resident).toBe(true);
    expect((await fetch(`${resident.baseUrl}/healthz`)).status).toBe(200);
    await resident.shutdown();
  });

  it("keeps independent launch leases for concurrent launchers", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const directory = await runtimeDirectory();
    const controlPlaneDirectory = await runtimeDirectory();
    const resident = await startResidentRuntime({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
      heartbeatMs: 5,
    });
    const [first, second] = await Promise.all([
      acquireGateway({ config: config(port, managementPort), runtimeDirectory: directory, controlPlaneDirectory, heartbeatMs: 5 }),
      acquireGateway({ config: config(port, managementPort), runtimeDirectory: directory, controlPlaneDirectory, heartbeatMs: 5 }),
    ]);
    expect(first.reused).toBe(true);
    expect(second.reused).toBe(true);
    expect(first.instanceId).toBe(resident.instanceId);
    expect(second.instanceId).toBe(resident.instanceId);
    await second.release();
    await first.release();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await fetch(`${resident.baseUrl}/healthz`)).status).toBe(200);
    await resident.shutdown();
  });

  it("is a no-op when a compatible resident runtime is already running", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const directory = await runtimeDirectory();
    const controlPlaneDirectory = await runtimeDirectory();
    const first = await startResidentRuntime({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
      heartbeatMs: 5,
    });
    const second = await startResidentRuntime({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
      heartbeatMs: 5,
    });
    expect(second.alreadyRunning).toBe(true);
    expect(second.instanceId).toBe(first.instanceId);
    await first.shutdown();
  });

  it("fails closed on a foreign gateway listener and leaves it untouched", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const directory = await runtimeDirectory();
    const controlPlaneDirectory = await runtimeDirectory();
    const authorizationHeaders: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      authorizationHeaders.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ product: "foreign" }));
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    await expect(startResidentRuntime({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
    })).rejects.toThrow("occupied by a foreign listener");
    expect(authorizationHeaders).not.toContain(expect.any(String));
    expect(server.listening).toBe(true);
  });

  it("recovers a stale ownership record on start", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const directory = await runtimeDirectory();
    const controlPlaneDirectory = await runtimeDirectory();
    const store = new RuntimeStore(directory);
    await store.writeInstanceSecret("stale-secret");
    await store.writeOwnershipRecord({
      pid: 999_999,
      processStartedAt: "2026-08-13T00:00:00.000Z",
      instanceId: "00000000-0000-4000-8000-000000000001",
      port,
      executableFingerprint: "a".repeat(64),
      configFingerprint: "b".repeat(64),
      nonceHash: "c".repeat(64),
      ownerLauncherPid: 999_998,
      leases: [],
    });
    expect(await inspectGateway(config(port, managementPort), directory)).toBe("stale-record");
    const resident = await startResidentRuntime({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
      heartbeatMs: 5,
    });
    const state = await inspectRuntimeGateway(config(port, managementPort), directory);
    expect(state.state).toBe("attested-compatible");
    if (state.state === "attested-compatible") expect(state.resident).toBe(true);
    await resident.shutdown();
  });

  it("explicit shutdown revokes sessions, closes listeners, and cleans artifacts", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const directory = await runtimeDirectory();
    const controlPlaneDirectory = await runtimeDirectory();
    const resident = await startResidentRuntime({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
      heartbeatMs: 5,
    });
    const launcher = await acquireGateway({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
      heartbeatMs: 5,
    });
    expect((await fetch(`${resident.baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${launcher.managementBaseUrl}/healthz`)).status).toBe(200);

    await resident.shutdown();
    await resident.stopped;

    await expect(fetch(`${resident.baseUrl}/healthz`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
    await expect(fetch(`${launcher.managementBaseUrl}/healthz`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
    const store = new RuntimeStore(directory);
    expect(await store.readOwnershipRecord()).toBeUndefined();
    expect(await store.readInstanceSecret()).toBeUndefined();
    expect(await inspectGateway(config(port, managementPort), directory)).toBe("not-running");
  });

  it("shutdown is idempotent", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const directory = await runtimeDirectory();
    const controlPlaneDirectory = await runtimeDirectory();
    const resident = await startResidentRuntime({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
      heartbeatMs: 5,
    });
    await resident.shutdown();
    await expect(resident.shutdown()).resolves.toBeUndefined();
  });

  it("stops an attested resident runtime through the authenticated shutdown route", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const directory = await runtimeDirectory();
    const controlPlaneDirectory = await runtimeDirectory();
    const resident = await startResidentRuntime({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
      heartbeatMs: 5,
    });
    const store = new RuntimeStore(directory);
    const secret = await store.readInstanceSecret();
    expect(secret).toBeDefined();

    const unauthorized = await fetch(`${resident.baseUrl}/shutdown`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(unauthorized.status).toBe(401);

    const result = await stopResidentRuntime(config(port, managementPort), { directory });
    expect(result).toEqual({ state: "stopped" });
    await resident.stopped;
    await expect(fetch(`${resident.baseUrl}/healthz`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  });

  it("refuses to stop an attested launcher-owned instance", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const directory = await runtimeDirectory();
    const controlPlaneDirectory = await runtimeDirectory();
    const launcher = await acquireGateway({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
      heartbeatMs: 5,
    });
    await expect(stopResidentRuntime(config(port, managementPort), { directory }))
      .rejects.toThrow("launcher session holds the gateway");
    expect((await fetch(`${launcher.baseUrl}/healthz`)).status).toBe(200);
    await launcher.release();
  });

  it("waits bounded for a compatible launcher-owned instance to drain", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const directory = await runtimeDirectory();
    const controlPlaneDirectory = await runtimeDirectory();
    const launcher = await acquireGateway({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
      heartbeatMs: 5,
    });
    await expect(startResidentRuntime({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
      heartbeatMs: 5,
    }, { drainTimeoutMs: 150 })).rejects.toThrow("non-resident launcher session holds the gateway");
    expect((await fetch(`${launcher.baseUrl}/healthz`)).status).toBe(200);
    await launcher.release();
  });
});
