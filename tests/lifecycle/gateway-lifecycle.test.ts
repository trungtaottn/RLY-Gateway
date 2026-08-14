import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayConfigSchema, type GatewayConfig } from "../../src/config/schema.js";
import { acquireGateway, closeGatewayBounded, inspectGateway } from "../../src/runtime/gateway-lifecycle.js";
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
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-lifecycle-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("gateway lifecycle coordinator", () => {
  it("bounds a slow gateway shutdown and closes its connections", async () => {
    vi.useFakeTimers();
    try {
      const closeAllConnections = vi.fn();
      const closing = closeGatewayBounded({
        close: () => new Promise(() => undefined),
        server: { closeAllConnections },
      }, 10);
      await vi.advanceTimersByTimeAsync(10);
      await expect(closing).resolves.toEqual({ forced: true });
      expect(closeAllConnections).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a rejected close as forced and closes owned connections", async () => {
    const closeAllConnections = vi.fn();
    await expect(closeGatewayBounded({
      close: () => Promise.reject(new Error("close failed")),
      server: { closeAllConnections },
    }, 10)).resolves.toEqual({ forced: true });
    expect(closeAllConnections).toHaveBeenCalledOnce();
  });

  it("reuses one attested instance for concurrent launchers", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const directory = await runtimeDirectory();
    const controlPlaneDirectory = await runtimeDirectory();
    const [first, second] = await Promise.all([
      acquireGateway({ config: config(port, managementPort), runtimeDirectory: directory, controlPlaneDirectory }),
      acquireGateway({ config: config(port, managementPort), runtimeDirectory: directory, controlPlaneDirectory }),
    ]);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    expect(second.instanceId).toBe(first.instanceId);
    expect(second.authToken).toBe(first.authToken);
    await second.release();
    await first.release();
  });

  it("keeps the initial launcher lease alive with heartbeats", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const directory = await runtimeDirectory();
    const controlPlaneDirectory = await runtimeDirectory();
    const lease = await acquireGateway({
      config: config(port, managementPort),
      runtimeDirectory: directory,
      controlPlaneDirectory,
      heartbeatMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await fetch(`${lease.baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${lease.managementBaseUrl}/healthz`)).status).toBe(200);
    expect(await inspectGateway(config(port, managementPort), directory)).toBe("attested-compatible");
    await lease.release();
  });

  it("fails closed for an attested instance with mismatched config", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const directory = await runtimeDirectory();
    const controlPlaneDirectory = await runtimeDirectory();
    const first = await acquireGateway({ config: config(port, managementPort), runtimeDirectory: directory, controlPlaneDirectory });
    await expect(acquireGateway({
      config: config(port, managementPort, "different-model"),
      runtimeDirectory: directory,
      controlPlaneDirectory,
    })).rejects.toThrow("attested but incompatible");
    await first.release();
  });

  it("reports not-running, attested, stale, and foreign states", async () => {
    const port = await availablePort();
    const managementPort = await availablePort();
    const directory = await runtimeDirectory();
    const controlPlaneDirectory = await runtimeDirectory();
    expect(await inspectGateway(config(port, managementPort), directory)).toBe("not-running");
    const lease = await acquireGateway({ config: config(port, managementPort), runtimeDirectory: directory, controlPlaneDirectory });
    expect(await inspectGateway(config(port, managementPort), directory)).toBe("attested-compatible");
    expect(await inspectGateway(config(port, managementPort, "different-model"), directory)).toBe("occupied-foreign");
    await lease.release();

    const stalePort = await availablePort();
    const staleDirectory = await runtimeDirectory();
    const store = new RuntimeStore(staleDirectory);
    await store.writeInstanceSecret("stale-secret");
    await store.writeOwnershipRecord({
      pid: 999_999,
      processStartedAt: "2026-08-13T00:00:00.000Z",
      instanceId: "00000000-0000-4000-8000-000000000001",
      port: stalePort,
      executableFingerprint: "a".repeat(64),
      configFingerprint: "b".repeat(64),
      nonceHash: "c".repeat(64),
      ownerLauncherPid: 999_998,
      leases: [],
    });
    expect(await inspectGateway(config(stalePort, await availablePort()), staleDirectory)).toBe("stale-record");
  });

  it("does not send authorization to a foreign listener", async () => {
    const port = await availablePort();
    const directory = await runtimeDirectory();
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
    await expect(acquireGateway({
      config: config(port, await availablePort()),
      runtimeDirectory: directory,
      controlPlaneDirectory: await runtimeDirectory(),
    })).rejects.toThrow("foreign or unattested");
    expect(authorizationHeaders).not.toContain(expect.any(String));
    expect(server.listening).toBe(true);
  });
});
