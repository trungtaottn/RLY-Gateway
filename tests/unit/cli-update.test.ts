import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUpdateArgs, runUpdateCommand, assertUpdateLaunchAllowed } from "../../src/cli/update.js";
import { parseCliArgs, runCli } from "../../src/cli/main.js";
import { gatewayConfigSchema, type GatewayConfig } from "../../src/config/schema.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import { UpdateStateStore } from "../../src/runtime/update/store.js";
import type { UpdateRunResult } from "../../src/runtime/update/lifecycle.js";
import { writeInstallation } from "../../src/storage/installation.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-gateway-update-cli-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function config(controlPlaneDirectory: string): GatewayConfig {
  return gatewayConfigSchema.parse({
    schemaVersion: 1,
    gateway: { host: "127.0.0.1", port: 17871, managementPort: 17872, logLevel: "silent" },
    controlPlane: { dataDirectory: controlPlaneDirectory },
    routes: {},
  });
}

describe("rly update CLI (#73)", () => {
  it("parses update flags and rejects unknown options", () => {
    expect(parseUpdateArgs([], "/work")).toEqual({ configPath: "/work/gateway.config.toml", force: false, waitTimeoutMs: 60_000 });
    expect(parseUpdateArgs(["--config", "cfg.toml", "--force", "--wait-timeout", "5000"], "/work")).toEqual({
      configPath: "/work/cfg.toml",
      force: true,
      waitTimeoutMs: 5_000,
    });
    expect(parseUpdateArgs(["--candidate", "dist", "--version", "2.0.0"], "/work")).toEqual({
      configPath: "/work/gateway.config.toml",
      force: false,
      waitTimeoutMs: 60_000,
      candidate: { sourceDirectory: "/work/dist", version: "2.0.0" },
    });
    expect(() => parseUpdateArgs(["--bogus"], "/work")).toThrow("unknown option");
    expect(() => parseUpdateArgs(["--version", "2.0.0"], "/work")).toThrow("--version requires --candidate");
    expect(() => parseUpdateArgs(["--wait-timeout", "abc"], "/work")).toThrow("positive millisecond");
  });

  it("dispatches through parseCliArgs and runCli", () => {
    expect(parseCliArgs(["update"], "/work")).toEqual({
      command: "update",
      options: { configPath: "/work/gateway.config.toml", force: false, waitTimeoutMs: 60_000 },
    });
    expect(parseCliArgs(["update", "--force", "--config", "cfg.toml"], "/work")?.command).toBe("update");
  });

  it("prints a no-candidate summary when nothing is pending", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    await writeInstallation(controlPlaneDirectory, {
      schemaVersion: 1,
      version: RUNTIME_VERSION,
      configPath: join(homeDir, "gateway.config.toml"),
      platform: "linux",
      serviceName: "rly-gateway",
      registeredAt: new Date().toISOString(),
    });
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const runUpdate = vi.fn().mockResolvedValue({
      outcome: "no-candidate",
      state: "idle",
      currentVersion: RUNTIME_VERSION,
      message: "no update candidate provided; nothing to activate",
    });
    const code = await runUpdateCommand({ configPath: join(homeDir, "gateway.config.toml"), force: false, waitTimeoutMs: 60_000 }, {
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
      runUpdate,
    });
    expect(code).toBe(0);
    const payload = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as { outcome: string; state: string };
    expect(payload.outcome).toBe("no-candidate");
    expect(payload.state).toBe("idle");
    expect(runUpdate).toHaveBeenCalledOnce();
  });

  it("requires rly init before update", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const code = await runUpdateCommand({ configPath: join(homeDir, "gateway.config.toml"), force: false, waitTimeoutMs: 60_000 }, {
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
    });
    expect(code).toBe(1);
    expect(String(output.mock.calls.at(-1)?.[0])).toContain("rly init");
  });

  it("maps a failed lifecycle outcome to a non-zero exit with a secret-free message", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    await writeInstallation(controlPlaneDirectory, {
      schemaVersion: 1,
      version: RUNTIME_VERSION,
      configPath: join(homeDir, "gateway.config.toml"),
      platform: "linux",
      serviceName: "rly-gateway",
      registeredAt: new Date().toISOString(),
    });
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const runUpdate = vi.fn().mockResolvedValue({
      outcome: "failed",
      state: "failed",
      currentVersion: RUNTIME_VERSION,
      pendingVersion: "2.0.0",
      message: "activation and rollback both failed; run rly doctor",
    });
    const code = await runUpdateCommand({ configPath: join(homeDir, "gateway.config.toml"), force: false, waitTimeoutMs: 60_000 }, {
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
      runUpdate,
    });
    expect(code).toBe(1);
    const printed = String(output.mock.calls.at(-1)?.[0]);
    expect(printed).toContain('"outcome":"failed"');
    expect(printed).not.toMatch(/Bearer|token|api[_-]?key|authorization|@/i);
  });

  it("routes through runCli dispatch", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    await writeInstallation(controlPlaneDirectory, {
      schemaVersion: 1,
      version: RUNTIME_VERSION,
      configPath: join(homeDir, "gateway.config.toml"),
      platform: "linux",
      serviceName: "rly-gateway",
      registeredAt: new Date().toISOString(),
    });
    const configPath = join(homeDir, "gateway.config.toml");
    await writeFile(configPath, [
      "schemaVersion = 1",
      "[gateway]",
      "logLevel = \"silent\"",
      "[controlPlane]",
      `dataDirectory = ${JSON.stringify(controlPlaneDirectory)}`,
    ].join("\n"), "utf8");
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const code = await runCli(["update", "--config", configPath], {
      environment: process.env,
    });
    expect(code).toBe(0);
    expect(String(output.mock.calls.at(-1)?.[0])).toContain('"outcome"');
  });

  it("refuses new launches on an incompatible resident pair while activation is pending", async () => {
    const controlPlaneDirectory = await directory();
    const store = new UpdateStateStore(controlPlaneDirectory);
    await store.write({
      schemaVersion: 1,
      state: "pending-activation",
      currentVersion: "0.1.0",
      pendingVersion: "2.0.0",
      previousVersion: "0.1.0",
      updatedAt: new Date().toISOString(),
    });
    const lease = {
      baseUrl: "http://127.0.0.1:17871",
      authToken: "instance-secret",
      managementBaseUrl: "http://127.0.0.1:17872",
      managementToken: "management-secret",
      instanceId: "00000000-0000-4000-8000-000000000073",
      leaseId: "00000000-0000-4000-8000-000000000074",
      reused: true,
      runtimeVersion: "0.1.0",
      release: () => Promise.resolve(),
    };
    // Incompatible pair: the serving runtime (2.0.0) differs in major from
    // this CLI (0.1.0) while activation is pending ⇒ new launches refused.
    await expect(assertUpdateLaunchAllowed({ ...lease, runtimeVersion: "2.0.0" }, config(controlPlaneDirectory)))
      .rejects.toThrow(/update-pending/);
    // A compatible pair (same major) keeps launching on the old runtime.
    const compatible = { ...lease, runtimeVersion: "0.1.0" };
    await expect(assertUpdateLaunchAllowed(compatible, config(controlPlaneDirectory))).resolves.toBeUndefined();
    // A launcher-owned handle (no runtimeVersion) is never gated.
    const launcherOwned = {
      baseUrl: lease.baseUrl,
      authToken: lease.authToken,
      managementBaseUrl: lease.managementBaseUrl,
      managementToken: lease.managementToken,
      instanceId: lease.instanceId,
      leaseId: lease.leaseId,
      reused: true,
      release: lease.release,
    };
    await expect(assertUpdateLaunchAllowed(launcherOwned, config(controlPlaneDirectory))).resolves.toBeUndefined();
  });

  it("reads the candidate version from its manifest", async () => {
    const homeDir = await directory();
    const controlPlaneDirectory = await directory();
    const candidate = await directory();
    await writeFile(join(candidate, "rly.json"), `${JSON.stringify({
      product: "rly-gateway",
      version: "9.0.0",
      stateVersion: 2,
      migrationForwardOnly: false,
    })}\n`, "utf8");
    await writeInstallation(controlPlaneDirectory, {
      schemaVersion: 1,
      version: RUNTIME_VERSION,
      configPath: join(homeDir, "gateway.config.toml"),
      platform: "linux",
      serviceName: "rly-gateway",
      registeredAt: new Date().toISOString(),
    });
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const runUpdate = vi.fn().mockImplementation(() => {
      const result: UpdateRunResult = {
        outcome: "no-candidate",
        state: "idle",
        currentVersion: RUNTIME_VERSION,
        message: "inspected",
      };
      return Promise.resolve(result);
    });
    const code = await runUpdateCommand({
      configPath: join(homeDir, "gateway.config.toml"),
      force: false,
      waitTimeoutMs: 60_000,
      candidate: { sourceDirectory: candidate },
    }, {
      loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
      runUpdate,
    });
    expect(code).toBe(0);
    expect(runUpdate).toHaveBeenCalledWith(expect.objectContaining({ candidate: { sourceDirectory: candidate, version: "9.0.0" } }));
  });
});
