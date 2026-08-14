import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayConfigSchema } from "../../src/config/schema.js";
import { acquireGateway, inspectGateway } from "../../src/runtime/gateway-lifecycle.js";

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

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agent-gateway-mgmt-life-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("management lifecycle", () => {
  it("fails closed on a foreign management listener without incrementing the port", async () => {
    const dataPort = await availablePort();
    const managementPort = await availablePort();
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.end("foreign");
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(managementPort, "127.0.0.1", resolve);
    });
    await expect(acquireGateway({
      config: gatewayConfigSchema.parse({
        schemaVersion: 1,
        gateway: { port: dataPort, managementPort, logLevel: "silent" },
      }),
      runtimeDirectory: await directory(),
      controlPlaneDirectory: await directory(),
    })).rejects.toThrow("management port is occupied by a foreign or unattested listener");
    expect(server.listening).toBe(true);
    expect(await inspectGateway(gatewayConfigSchema.parse({
      schemaVersion: 1,
      gateway: { port: dataPort, managementPort, logLevel: "silent" },
    }), await directory())).toBe("occupied-foreign");
  });

  it("stops the management listener with gateway teardown", async () => {
    const dataPort = await availablePort();
    const managementPort = await availablePort();
    const lease = await acquireGateway({
      config: gatewayConfigSchema.parse({
        schemaVersion: 1,
        gateway: { port: dataPort, managementPort, logLevel: "silent" },
      }),
      runtimeDirectory: await directory(),
      controlPlaneDirectory: await directory(),
    });
    expect((await fetch(`${lease.managementBaseUrl}/healthz`)).status).toBe(200);
    await lease.release();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await expect(fetch(`${lease.managementBaseUrl}/healthz`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  });

  it("does not accept the data-plane secret on the management listener", async () => {
    const dataPort = await availablePort();
    const managementPort = await availablePort();
    const lease = await acquireGateway({
      config: gatewayConfigSchema.parse({
        schemaVersion: 1,
        gateway: { port: dataPort, managementPort, logLevel: "silent" },
      }),
      runtimeDirectory: await directory(),
      controlPlaneDirectory: await directory(),
    });
    const wrong = await fetch(`${lease.managementBaseUrl}/readyz`, {
      headers: { authorization: `Bearer ${lease.authToken}` },
    });
    expect(wrong.status).toBe(401);
    const right = await fetch(`${lease.managementBaseUrl}/readyz`, {
      headers: { authorization: `Bearer ${lease.managementToken}` },
    });
    expect(right.status).toBe(200);
    await lease.release();
  });
});
