import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceManager } from "../../src/service-manager/index.js";
import type { ServiceCommandRunner, ServiceDefinitionInput } from "../../src/service-manager/types.js";

const directories: string[] = [];

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rly-service-home-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const definition: ServiceDefinitionInput = {
  serviceName: "rly-gateway",
  executable: "/usr/local/bin/node",
  entrypoint: "/opt/rly-gateway/dist/cli/main.js",
  configPath: "/work/gateway.config.toml",
};

function runnerMock(): { runner: ServiceCommandRunner; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: ServiceCommandRunner = (file, args) => {
    calls.push({ file, args: [...args] });
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { runner, calls };
}

describe("macOS LaunchAgent adapter", () => {
  it("registers idempotently with the plist and launchctl commands", async () => {
    const homeDir = await home();
    const { runner, calls } = runnerMock();
    const manager = createServiceManager({ platform: "darwin", home: homeDir, runner });
    expect(manager.platform).toBe("darwin");
    expect(manager.isSupported()).toBe(true);
    await manager.register(definition);
    await manager.register(definition);

    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.rly.gateway.plist");
    const plist = await readFile(plistPath, "utf8");
    expect(plist).toContain("<string>com.rly.gateway</string>");
    expect(plist).toContain("/opt/rly-gateway/dist/cli/main.js");
    expect(plist).not.toMatch(/Bearer|token|api[_-]?key|@/i);
    expect((await stat(plistPath)).mode & 0o777).toBe(0o600);

    // register bootstraps; a second register still rewrites and reloads (repair).
    expect(calls.filter((call) => call.args[0] === "bootstrap")).toHaveLength(2);
    expect(calls.every((call) => call.file === "/bin/launchctl")).toBe(true);

    await manager.start();
    expect(calls.at(-1)?.args).toEqual(["kickstart", `gui/${String(process.getuid?.() ?? 0)}`, "com.rly.gateway"]);
    expect(await manager.isRegistered()).toBe(true);
  });

  it("tolerates an already-loaded service during bootstrap", async () => {
    const homeDir = await home();
    const runner: ServiceCommandRunner = () => Promise.resolve({ code: 5, stdout: "", stderr: "service already loaded" });
    const manager = createServiceManager({ platform: "darwin", home: homeDir, runner });
    await expect(manager.register(definition)).resolves.toBeUndefined();
  });

  it("reports status from launchctl print", async () => {
    const homeDir = await home();
    const runner: ServiceCommandRunner = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
    const manager = createServiceManager({ platform: "darwin", home: homeDir, runner });
    expect(await manager.status()).toBe("not-registered");
    await manager.register(definition);
    expect(await manager.status()).toBe("running");
  });
});

describe("Linux systemd --user adapter", () => {
  it("registers idempotently with the unit and systemctl commands", async () => {
    const homeDir = await home();
    const { runner, calls } = runnerMock();
    const manager = createServiceManager({ platform: "linux", home: homeDir, runner });
    expect(manager.platform).toBe("linux");
    await manager.register(definition);
    await manager.register(definition);

    const unitPath = join(homeDir, ".config", "systemd", "user", "rly-gateway.service");
    const unit = await readFile(unitPath, "utf8");
    expect(unit).toContain("ExecStart=/usr/local/bin/node /opt/rly-gateway/dist/cli/main.js gateway start --config /work/gateway.config.toml");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).not.toMatch(/Bearer|token|api[_-]?key|@/i);
    expect((await stat(unitPath)).mode & 0o777).toBe(0o600);

    expect(calls.filter((call) => call.args.includes("daemon-reload"))).toHaveLength(2);

    await manager.start();
    expect(calls.at(-1)?.args).toEqual(["--user", "enable", "--now", "rly-gateway.service"]);
    expect(await manager.isRegistered()).toBe(true);
  });

  it("reports running/stopped from systemctl is-active", async () => {
    const homeDir = await home();
    const runner: ServiceCommandRunner = vi.fn((_file: string, args: readonly string[]) => {
      const active = args.includes("is-active");
      return Promise.resolve(active ? { code: 0, stdout: "active\n", stderr: "" } : { code: 0, stdout: "", stderr: "" });
    });
    const manager = createServiceManager({ platform: "linux", home: homeDir, runner });
    await manager.register(definition);
    expect(await manager.status()).toBe("running");
  });
});

describe("unsupported platforms", () => {
  it("reports not-supported with an actionable message", async () => {
    const homeDir = await home();
    const manager = createServiceManager({ platform: "win32", home: homeDir });
    expect(manager.isSupported()).toBe(false);
    expect(await manager.status()).toBe("not-registered");
    await expect(manager.register(definition)).rejects.toThrow("not supported on platform win32");
    await expect(manager.start()).rejects.toThrow("not supported on platform win32");
  });
});
