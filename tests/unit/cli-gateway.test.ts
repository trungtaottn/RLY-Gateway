import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGatewayCommand } from "../../src/cli/gateway.js";
import { gatewayConfigSchema, type GatewayConfig } from "../../src/config/schema.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import type { ResidentRuntimeHandle } from "../../src/runtime/resident-runtime.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-gateway-cmd-"));
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

function handle(alreadyRunning: boolean): ResidentRuntimeHandle {
  return {
    baseUrl: "http://127.0.0.1:17871",
    instanceId: "00000000-0000-4000-8000-000000000065",
    runtimeVersion: RUNTIME_VERSION,
    alreadyRunning,
    shutdown: () => Promise.resolve(),
    stopped: Promise.resolve(),
  };
}

type CommandPayload = {
  ok?: boolean;
  running?: boolean;
  resident?: boolean;
  stopped?: boolean;
  state?: string;
  instanceId?: string;
  service?: { registered: boolean };
};

function parseOutput(output: ReturnType<typeof vi.fn>): CommandPayload {
  return JSON.parse(String(output.mock.calls[0]?.[0])) as CommandPayload;
}

describe("rly gateway commands", () => {
  it("starts a resident runtime and reports identity/version", async () => {
    const homeDir = await directory();
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const code = await runGatewayCommand("start", join(homeDir, "gateway.config.toml"), {
      loadConfig: () => Promise.resolve(config(homeDir)),
      startResidentRuntime: () => Promise.resolve(handle(false)),
    });
    expect(code).toBe(0);
    const payload = parseOutput(output);
    expect(payload.ok).toBe(true);
    expect(payload.running).toBe(true);
    expect(payload.resident).toBe(true);
    expect(payload.instanceId).toBe("00000000-0000-4000-8000-000000000065");
  });

  it("treats an already-running resident service as an idempotent no-op", async () => {
    const homeDir = await directory();
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const code = await runGatewayCommand("start", join(homeDir, "gateway.config.toml"), {
      loadConfig: () => Promise.resolve(config(homeDir)),
      startResidentRuntime: () => Promise.resolve(handle(true)),
    });
    expect(code).toBe(0);
    const payload = parseOutput(output);
    expect(payload.running).toBe(true);
    expect(payload.resident).toBe(true);
  });

  it("stops the resident service through the attested shutdown path", async () => {
    const homeDir = await directory();
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const stop = vi.fn().mockResolvedValue({ state: "stopped" });
    const code = await runGatewayCommand("stop", join(homeDir, "gateway.config.toml"), {
      loadConfig: () => Promise.resolve(config(homeDir)),
      stopResidentRuntime: stop,
    });
    expect(code).toBe(0);
    expect(stop).toHaveBeenCalledOnce();
    const payload = parseOutput(output);
    expect(payload.stopped).toBe(true);
  });

  it("reports not-running state for status without a runtime", async () => {
    const homeDir = await directory();
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const code = await runGatewayCommand("status", join(homeDir, "gateway.config.toml"), {
      loadConfig: () => Promise.resolve(config(homeDir)),
    });
    expect(code).toBe(1);
    const payload = parseOutput(output);
    expect(payload.running).toBe(false);
    expect(payload.state).toBe("not-running");
    expect(payload.service?.registered).toBe(false);
  });
});
