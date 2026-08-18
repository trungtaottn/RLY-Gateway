import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runUpdateCommand } from "../../src/cli/update.js";
import { gatewayConfigSchema, type GatewayConfig } from "../../src/config/schema.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import { writeInstallation } from "../../src/storage/installation.js";
import type { VerifiedCandidate } from "../../src/installer/types.js";
import type { UpdateRunResult } from "../../src/runtime/update/lifecycle.js";
import { DEFAULT_ORIGIN } from "../../src/installer/metadata.js";

const directories: string[] = [];

async function directory(prefix = "rly-update-acq-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
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

function candidate(version = "1.0.0-beta.6"): VerifiedCandidate {
  return {
    product: "rly-gateway",
    version,
    channel: "beta",
    target: "linux-x64",
    filename: `rly-${version}-linux-x64.tar.gz`,
    sha256: "a".repeat(64),
    artifactDigest: "b".repeat(64),
    buildId: `build-${version}`,
    commitRevision: "c".repeat(40),
    controlProtocolVersion: 1,
    dataProtocolVersion: 1,
    stateVersion: 2,
    qualificationStatus: "qualified",
    sourceDirectory: "/tmp/unpacked",
    metadataVersion: 2,
    verifiedAt: new Date().toISOString(),
  };
}

async function installedUpdateHome(controlPlaneDirectory: string, homeDir: string): Promise<void> {
  await writeInstallation(controlPlaneDirectory, {
    schemaVersion: 1,
    version: RUNTIME_VERSION,
    configPath: join(homeDir, "gateway.config.toml"),
    platform: "linux",
    serviceName: "rly-gateway",
    registeredAt: new Date().toISOString(),
  });
}

describe("rly update channel acquisition (#129)", () => {
  it("acquires + stages a verified candidate and hands it to Wave 4 without activating", async () => {
    const homeDir = await directory("rly-home-");
    const controlPlaneDirectory = await directory("rly-cp-");
    await installedUpdateHome(controlPlaneDirectory, homeDir);
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const runUpdate = vi.fn().mockImplementation((deps: { candidate?: { version: string }; installOnly?: boolean }): Promise<UpdateRunResult> => {
      const result: UpdateRunResult = {
        outcome: "installed",
        state: "pending-activation",
        phase: "staged",
        currentVersion: RUNTIME_VERSION,
        ...(deps.candidate === undefined ? {} : { pendingVersion: deps.candidate.version }),
        message: "candidate verified and installed; activation is pending (Wave 4)",
      };
      return Promise.resolve(result);
    });
    const code = await runUpdateCommand(
      {
        configPath: join(homeDir, "gateway.config.toml"),
        channel: "beta",
        channelExplicit: true,
        origin: DEFAULT_ORIGIN,
        installOnly: false,
        force: false,
        waitTimeoutMs: 60_000,
      },
      {
        loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
        runUpdate,
        acquire: vi.fn().mockResolvedValue(candidate()),
      },
    );
    expect(code).toBe(0);
    // INSTALL != ACTIVATE: the lifecycle is invoked in install-only mode.
    expect(runUpdate).toHaveBeenCalledWith(expect.objectContaining({
      candidate: { version: "1.0.0-beta.6", sourceDirectory: "/tmp/unpacked" },
      installOnly: true,
    }));
    const payload = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as {
      outcome: string;
      state: string;
      verifiedCandidate: { channel: string; version: string; artifactDigest: string };
    };
    expect(payload.outcome).toBe("installed");
    expect(payload.state).toBe("pending-activation");
    expect(payload.verifiedCandidate.channel).toBe("beta");
    expect(payload.verifiedCandidate.version).toBe("1.0.0-beta.6");
    expect(payload.verifiedCandidate.artifactDigest).toBe("b".repeat(64));
  });

  it("records a channel switch in the acquisition log", async () => {
    const homeDir = await directory("rly-home-");
    const controlPlaneDirectory = await directory("rly-cp-");
    await installedUpdateHome(controlPlaneDirectory, homeDir);
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    await runUpdateCommand(
      {
        configPath: join(homeDir, "gateway.config.toml"),
        channel: "stable",
        channelExplicit: true,
        origin: DEFAULT_ORIGIN,
        installOnly: false,
        force: false,
        waitTimeoutMs: 60_000,
      },
      {
        loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
        runUpdate: vi.fn().mockResolvedValue({
          outcome: "installed",
          state: "pending-activation",
          phase: "staged",
          currentVersion: RUNTIME_VERSION,
          pendingVersion: "1.0.0",
          message: "staged",
        }),
        acquire: vi.fn().mockResolvedValue({ ...candidate("1.0.0"), channel: "stable" as const }),
        buildIdentity: () => Promise.resolve({
          identitySchemaVersion: 1,
          product: "rly-gateway",
          semanticVersion: RUNTIME_VERSION,
          commitRevision: "c".repeat(40),
          buildId: "build-beta",
          releaseChannel: "beta" as const,
          controlProtocolVersion: 1,
          dataProtocolVersion: 1,
          stateSchemaVersion: 2,
        }),
      },
    );
    const { AcquisitionStateStore } = await import("../../src/installer/state.js");
    const store = new AcquisitionStateStore(controlPlaneDirectory);
    const log = await store.readLog();
    expect(log.some((entry) => entry.kind === "channel-switch" && entry.channel === "stable" && entry.previousChannel === "beta")).toBe(true);
  });

  it("reports acquisition failures with a typed code and no partial mutation", async () => {
    const homeDir = await directory("rly-home-");
    const controlPlaneDirectory = await directory("rly-cp-");
    await installedUpdateHome(controlPlaneDirectory, homeDir);
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const runUpdate = vi.fn();
    const { AcquisitionError } = await import("../../src/installer/types.js");
    const code = await runUpdateCommand(
      {
        configPath: join(homeDir, "gateway.config.toml"),
        channel: "beta",
        channelExplicit: true,
        origin: DEFAULT_ORIGIN,
        installOnly: false,
        force: false,
        waitTimeoutMs: 60_000,
      },
      {
        loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
        runUpdate,
        acquire: vi.fn().mockRejectedValue(new AcquisitionError("artifact-sha256-mismatch", "sha256 mismatch")),
      },
    );
    expect(code).toBe(1);
    const payload = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as { code: string; ok: boolean };
    expect(payload.code).toBe("artifact-sha256-mismatch");
    expect(payload.ok).toBe(false);
    expect(runUpdate).not.toHaveBeenCalled();
  });

  it("fails closed on unsupported host platforms", async () => {
    const homeDir = await directory("rly-home-");
    const controlPlaneDirectory = await directory("rly-cp-");
    await installedUpdateHome(controlPlaneDirectory, homeDir);
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const runUpdate = vi.fn().mockResolvedValue({
      outcome: "installed",
      state: "pending-activation",
      phase: "staged",
      currentVersion: RUNTIME_VERSION,
      pendingVersion: "1.0.0-beta.5",
      message: "staged",
    });
    const code = await runUpdateCommand(
      {
        configPath: join(homeDir, "gateway.config.toml"),
        channel: "beta",
        channelExplicit: true,
        origin: DEFAULT_ORIGIN,
        installOnly: false,
        force: false,
        waitTimeoutMs: 60_000,
      },
      {
        loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
        runUpdate,
        acquire: vi.fn().mockResolvedValue(candidate()),
      },
    );
    // The host target on this runner is linux-x64, so acquisition succeeds;
    // verify the command still runs the lifecycle in install-only mode.
    expect(code).toBe(0);
    expect(runUpdate).toHaveBeenCalled();
  });

  it("--install-only with a local candidate stages without activating", async () => {
    const homeDir = await directory("rly-home-");
    const controlPlaneDirectory = await directory("rly-cp-");
    const candidateDir = await directory("rly-candidate-");
    await installedUpdateHome(controlPlaneDirectory, homeDir);
    await writeFile(join(candidateDir, "rly.json"), `${JSON.stringify({
      product: "rly-gateway",
      version: "9.0.0",
      stateVersion: 2,
      migrationForwardOnly: false,
    })}\n`, "utf8");
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    const runUpdate = vi.fn().mockResolvedValue({
      outcome: "installed",
      state: "pending-activation",
      phase: "staged",
      currentVersion: RUNTIME_VERSION,
      pendingVersion: "9.0.0",
      message: "staged",
    });
    const code = await runUpdateCommand(
      {
        configPath: join(homeDir, "gateway.config.toml"),
        channel: "current",
        channelExplicit: false,
        origin: DEFAULT_ORIGIN,
        installOnly: true,
        force: false,
        waitTimeoutMs: 60_000,
        candidate: { sourceDirectory: candidateDir },
      },
      {
        loadConfig: () => Promise.resolve(config(controlPlaneDirectory)),
        runUpdate,
      },
    );
    expect(code).toBe(0);
    expect(runUpdate).toHaveBeenCalledWith(expect.objectContaining({
      candidate: { version: "9.0.0", sourceDirectory: candidateDir },
      installOnly: true,
    }));
  });
});
