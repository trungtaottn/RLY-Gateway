import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { gatewayConfigSchema, type GatewayConfig } from "../../src/config/schema.js";
import type { RuntimeInspection } from "../../src/runtime/gateway-lifecycle.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import type { createServiceManager } from "../../src/service-manager/index.js";
import type { ServiceManagerAdapter } from "../../src/service-manager/types.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-init-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function config(dataDirectory: string): GatewayConfig {
  return gatewayConfigSchema.parse({
    schemaVersion: 1,
    gateway: { host: "127.0.0.1", port: 17871, managementPort: 17872, logLevel: "silent" },
    controlPlane: { dataDirectory },
    routes: {},
  });
}

function fakeManager(calls: { registered: number; started: number }): ServiceManagerAdapter {
  return {
    platform: "linux",
    serviceName: "rly-gateway",
    isSupported: () => true,
    isRegistered: () => Promise.resolve(calls.registered > 0),
    register: () => { calls.registered += 1; return Promise.resolve(undefined); },
    unregister: () => Promise.resolve(undefined),
    start: () => { calls.started += 1; return Promise.resolve(undefined); },
    restart: () => { calls.started += 1; return Promise.resolve(undefined); },
    stop: () => Promise.resolve(undefined),
    status: () => Promise.resolve("running"),
  };
}

function readyInspection(): RuntimeInspection {
  return {
    state: "attested-compatible",
    resident: true,
    runtimeVersion: RUNTIME_VERSION,
    instanceId: "00000000-0000-4000-8000-000000000065",
  };
}

type InitPayload = {
  ok: boolean;
  initialized: boolean;
  reinitialized?: boolean;
  service: { registered: boolean; platform?: string };
  runtime?: { state: string; resident?: boolean; instanceId?: string; runtimeVersion?: string };
};

function parseOutput(output: ReturnType<typeof vi.fn>): InitPayload {
  return JSON.parse(String(output.mock.calls[0]?.[0])) as InitPayload;
}

describe("rly init", () => {
  it("registers and starts the service, writes the installation record, and reports readiness", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    const configPath = join(homeDir, "gateway.config.toml");
    const calls = { registered: 0, started: 0 };
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);

    const code = await runInit(configPath, {
      home: homeDir,
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
      openControlPlane: () => Promise.resolve(undefined),
      createServiceManager: () => fakeManager(calls),
      waitForReadiness: () => Promise.resolve(readyInspection()),
    });
    expect(code).toBe(0);
    expect(calls.registered).toBe(1);
    expect(calls.started).toBe(1);

    const installation = JSON.parse(await readFile(join(controlPlaneDirectory, "installation.json"), "utf8")) as {
      schemaVersion: number;
      version: string;
      configPath: string;
      platform: string;
      serviceName: string;
      registeredAt: string;
    };
    expect(installation.schemaVersion).toBe(1);
    expect(installation.version).toBe(RUNTIME_VERSION);
    expect(installation.configPath).toBe(configPath);
    expect(installation.platform).toBe("linux");
    expect(installation.serviceName).toBe("rly-gateway");
    expect(installation.registeredAt).toBeDefined();

    const payload = parseOutput(output);
    expect(payload.ok).toBe(true);
    expect(payload.initialized).toBe(true);
    expect(payload.runtime?.resident).toBe(true);
    expect(payload.service.registered).toBe(true);
  });

  it("is idempotent: a second init repairs rather than duplicating services", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    const configPath = join(homeDir, "gateway.config.toml");
    const calls = { registered: 0, started: 0 };
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);

    const dependencies = {
      home: homeDir,
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
      openControlPlane: () => Promise.resolve(undefined),
      createServiceManager: () => fakeManager(calls),
      waitForReadiness: () => Promise.resolve(readyInspection()),
    };
    expect(await runInit(configPath, dependencies)).toBe(0);
    expect(await runInit(configPath, dependencies)).toBe(0);
    expect(calls.registered).toBe(2); // re-registration rewrites/repairs, never duplicates
    const payload = parseOutput(output);
    expect(payload.reinitialized).toBe(true);
  });

  it("reports failure when the resident runtime never becomes ready", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const code = await runInit(join(homeDir, "gateway.config.toml"), {
      home: homeDir,
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
      openControlPlane: () => Promise.resolve(undefined),
      createServiceManager: () => fakeManager({ registered: 0, started: 0 }),
      waitForReadiness: () => Promise.resolve({ state: "occupied-foreign" }),
    });
    expect(code).toBe(1);
    const payload = parseOutput(output);
    expect(payload.ok).toBe(false);
    expect(payload.runtime?.state).toBe("occupied-foreign");
  });

  it("passes the durable log and working paths into the service manager", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    const captured: { options?: Parameters<typeof createServiceManager>[0] } = {};
    const createManager: (input: Parameters<typeof createServiceManager>[0]) => ServiceManagerAdapter = (input) => {
      captured.options = input;
      return fakeManager({ registered: 0, started: 0 });
    };
    const code = await runInit(join(homeDir, "gateway.config.toml"), {
      home: homeDir,
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
      openControlPlane: () => Promise.resolve(undefined),
      createServiceManager: createManager,
      waitForReadiness: () => Promise.resolve(readyInspection()),
    });
    expect(code).toBe(0);
    expect(captured.options).toMatchObject({
      home: homeDir,
      logPath: join(controlPlaneDirectory, "logs", "service.log"),
      workingDirectory: controlPlaneDirectory,
    });
  });

  it("skips service registration on unsupported platforms but still initializes the home", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const unsupported: ServiceManagerAdapter = {
      platform: "unsupported",
      serviceName: "rly-gateway",
      isSupported: () => false,
      isRegistered: () => Promise.resolve(false),
      register: () => Promise.resolve(undefined),
      unregister: () => Promise.resolve(undefined),
      start: () => Promise.resolve(undefined),
      restart: () => Promise.resolve(undefined),
      stop: () => Promise.resolve(undefined),
      status: () => Promise.resolve("not-registered"),
    };
    const code = await runInit(join(homeDir, "gateway.config.toml"), {
      home: homeDir,
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
      openControlPlane: () => Promise.resolve(undefined),
      createServiceManager: () => unsupported,
    });
    expect(code).toBe(0);
    const payload = parseOutput(output);
    expect(payload.ok).toBe(true);
    expect(payload.service.registered).toBe(false);
  });
});
