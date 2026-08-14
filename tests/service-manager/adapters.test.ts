import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceManager } from "../../src/service-manager/index.js";
import type { LaunchAgentAdapter } from "../../src/service-manager/launch-agent.js";
import type { SystemdUserAdapter } from "../../src/service-manager/systemd-user.js";
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

  it("reports running/stopped from the launchctl print state", async () => {
    const homeDir = await home();
    const runner: ServiceCommandRunner = vi.fn((_file: string, args: readonly string[]) => {
      const printing = args[0] === "print";
      return Promise.resolve(printing
        ? { code: 0, stdout: "state = running\npid = 4242\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" });
    });
    const manager = createServiceManager({ platform: "darwin", home: homeDir, runner });
    expect(await manager.status()).toBe("not-registered");
    await manager.register(definition);
    expect(await manager.status()).toBe("running");
  });

  it("reports stopped when the job is loaded but has no running process", async () => {
    const homeDir = await home();
    const runner: ServiceCommandRunner = vi.fn((_file: string, args: readonly string[]) => {
      const printing = args[0] === "print";
      return Promise.resolve(printing
        ? { code: 0, stdout: "state = waiting\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" });
    });
    const manager = createServiceManager({ platform: "darwin", home: homeDir, runner });
    await manager.register(definition);
    expect(await manager.status()).toBe("stopped");
  });

  it("reports label, load state, and pid separately from runtime readiness", async () => {
    const homeDir = await home();
    const runner: ServiceCommandRunner = vi.fn((_file: string, args: readonly string[]) => {
      const printing = args[0] === "print";
      return Promise.resolve(printing
        ? { code: 0, stdout: "service = com.rly.gateway\nstate = running\npid = 4242\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" });
    });
    const manager = createServiceManager({ platform: "darwin", home: homeDir, runner }) as LaunchAgentAdapter;
    expect(await manager.detail()).toMatchObject({ registered: false, loaded: false, running: false });
    await manager.register(definition);
    const detail = await manager.detail();
    expect(detail).toMatchObject({
      label: "com.rly.gateway",
      registered: true,
      loaded: true,
      running: true,
      pid: 4242,
    });
    expect(detail.definitionPath).toBe(join(homeDir, "Library", "LaunchAgents", "com.rly.gateway.plist"));
  });

  it("repairs a changed definition by unloading before reloading", async () => {
    const homeDir = await home();
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: ServiceCommandRunner = (file, args) => {
      calls.push({ file, args: [...args] });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const manager = createServiceManager({ platform: "darwin", home: homeDir, runner });
    await manager.register(definition);
    await manager.register({ ...definition, executable: "/usr/local/bin/node-v24" });
    const bootstraps = calls.filter((call) => call.args[0] === "bootstrap");
    const bootouts = calls.filter((call) => call.args[0] === "bootout");
    expect(bootstraps).toHaveLength(2);
    expect(bootouts).toHaveLength(1);
    expect(calls.findIndex((call) => call.args[0] === "bootout"))
      .toBeGreaterThan(calls.findIndex((call) => call.args[0] === "bootstrap"));
    expect(calls.findLastIndex((call) => call.args[0] === "bootstrap"))
      .toBeGreaterThan(calls.findIndex((call) => call.args[0] === "bootout"));
    const plist = await readFile(join(homeDir, "Library", "LaunchAgents", "com.rly.gateway.plist"), "utf8");
    expect(plist).toContain("/usr/local/bin/node-v24");
  });

  it("keeps an unchanged re-registration a no-op reload without duplicate labels", async () => {
    const homeDir = await home();
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: ServiceCommandRunner = (file, args) => {
      calls.push({ file, args: [...args] });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const manager = createServiceManager({ platform: "darwin", home: homeDir, runner });
    await manager.register(definition);
    await manager.register(definition);
    const bootouts = calls.filter((call) => call.args[0] === "bootout");
    const bootstraps = calls.filter((call) => call.args[0] === "bootstrap");
    expect(bootouts).toHaveLength(0);
    expect(bootstraps).toHaveLength(2);
  });

  it("falls back to legacy launchctl subcommands when v2 is unsupported", async () => {
    const homeDir = await home();
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: ServiceCommandRunner = (file, args) => {
      calls.push({ file, args: [...args] });
      const subcommand = args[0];
      if (subcommand === "print" || subcommand === "bootstrap" || subcommand === "kickstart" || subcommand === "bootout") {
        return Promise.resolve({ code: 64, stdout: "", stderr: `launchctl: The '${subcommand}' subcommand is not supported` });
      }
      if (subcommand === "list") {
        return Promise.resolve({ code: 0, stdout: "4242\tcom.rly.gateway\t0\n", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const manager = createServiceManager({ platform: "darwin", home: homeDir, runner });
    await manager.register(definition);
    await manager.start();
    await manager.stop();
    expect(await manager.status()).toBe("running");
    expect(calls.some((call) => call.args[0] === "load" && call.args[1] === "-w")).toBe(true);
    expect(calls.some((call) => call.args[0] === "start" && call.args[1] === "com.rly.gateway")).toBe(true);
    expect(calls.some((call) => call.args[0] === "unload")).toBe(true);
    expect(calls.some((call) => call.args[0] === "list")).toBe(true);
  });

  it("restarts the job through kickstart -k for the #73 restart path", async () => {
    const homeDir = await home();
    const { runner, calls } = runnerMock();
    const manager = createServiceManager({ platform: "darwin", home: homeDir, runner }) as LaunchAgentAdapter;
    await manager.restart();
    expect(calls.at(-1)?.args).toEqual(["kickstart", "-k", `gui/${String(process.getuid?.() ?? 0)}`, "com.rly.gateway"]);
  });

  it("stop tolerates an already-unloaded job", async () => {
    const homeDir = await home();
    const runner: ServiceCommandRunner = () => Promise.resolve({ code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" });
    const manager = createServiceManager({ platform: "darwin", home: homeDir, runner });
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it("writes working directory and the RLY log path into the plist", async () => {
    const homeDir = await home();
    const { runner } = runnerMock();
    const manager = createServiceManager({
      platform: "darwin",
      home: homeDir,
      runner,
      workingDirectory: join(homeDir, ".rly"),
      logPath: join(homeDir, ".rly", "logs", "service.log"),
    });
    await manager.register(definition);
    const plist = await readFile(join(homeDir, "Library", "LaunchAgents", "com.rly.gateway.plist"), "utf8");
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain(join(homeDir, ".rly"));
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain(join(homeDir, ".rly", "logs", "service.log"));
    await expect(stat(join(homeDir, ".rly", "logs"))).resolves.toBeDefined();
  });

  it("unregister unloads and removes only the RLY-owned plist", async () => {
    const homeDir = await home();
    const { runner, calls } = runnerMock();
    const manager = createServiceManager({ platform: "darwin", home: homeDir, runner });
    await manager.register(definition);
    expect(await manager.isRegistered()).toBe(true);
    await manager.unregister();
    expect(await manager.isRegistered()).toBe(false);
    expect(calls.some((call) => call.args[0] === "bootout")).toBe(true);
    await expect(readFile(join(homeDir, "Library", "LaunchAgents", "com.rly.gateway.plist"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(typeof process.getuid !== "function")("refuses to run as root", async () => {
    const homeDir = await home();
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(0);
    try {
      const manager = createServiceManager({ platform: "darwin", home: homeDir, runner: runnerMock().runner });
      await expect(manager.register(definition)).rejects.toThrow(/must not run as root/);
    } finally {
      getuid.mockRestore();
    }
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
    expect(unit).toContain("StartLimitIntervalSec=60");
    expect(unit).not.toMatch(/Bearer|token|api[_-]?key|@/i);
    expect((await stat(unitPath)).mode & 0o777).toBe(0o600);

    // The probe runs before every mutating op; daemon-reload runs only when
    // the definition actually changed, so an identical re-init stays a no-op.
    expect(calls.filter((call) => call.args.includes("show-environment"))).toHaveLength(2);
    expect(calls.filter((call) => call.args.includes("daemon-reload"))).toHaveLength(1);
    expect(calls.every((call) => call.file === "systemctl")).toBe(true);

    await manager.start();
    expect(calls.at(-1)?.args).toEqual(["--user", "enable", "--now", "rly-gateway.service"]);
    expect(await manager.isRegistered()).toBe(true);
  });

  it("repairs a changed definition with a daemon-reload and no duplicate unit", async () => {
    const homeDir = await home();
    const { runner, calls } = runnerMock();
    const manager = createServiceManager({ platform: "linux", home: homeDir, runner });
    await manager.register(definition);
    await manager.register({ ...definition, executable: "/usr/local/bin/node-v24" });
    expect(calls.filter((call) => call.args.includes("daemon-reload"))).toHaveLength(2);
    const unit = await readFile(join(homeDir, ".config", "systemd", "user", "rly-gateway.service"), "utf8");
    expect(unit).toContain("/usr/local/bin/node-v24");
    expect(unit).not.toContain("/usr/local/bin/node ");
  });

  it("reports running with pid and enabled state from systemctl show", async () => {
    const homeDir = await home();
    const runner: ServiceCommandRunner = vi.fn((_file: string, args: readonly string[]) => {
      const showing = args.includes("show");
      return Promise.resolve(showing
        ? { code: 0, stdout: "active\nrunning\n4242\nenabled\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" });
    });
    const manager = createServiceManager({ platform: "linux", home: homeDir, runner }) as SystemdUserAdapter;
    expect(await manager.status()).toBe("not-registered");
    await manager.register(definition);
    expect(await manager.status()).toBe("running");
    expect(await manager.detail()).toMatchObject({
      registered: true,
      loaded: true,
      running: true,
      pid: 4242,
      enabled: true,
      activeState: "active",
    });
  });

  it("reports stopped when the unit is inactive", async () => {
    const homeDir = await home();
    const runner: ServiceCommandRunner = vi.fn((_file: string, args: readonly string[]) => {
      const showing = args.includes("show");
      return Promise.resolve(showing
        ? { code: 0, stdout: "inactive\ndead\n0\ndisabled\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" });
    });
    const manager = createServiceManager({ platform: "linux", home: homeDir, runner }) as SystemdUserAdapter;
    await manager.register(definition);
    expect(await manager.status()).toBe("stopped");
    expect(await manager.detail()).toMatchObject({ loaded: true, running: false, enabled: false, activeState: "inactive" });
  });

  it("reports failed state so repeated startup failure is diagnosable", async () => {
    const homeDir = await home();
    const runner: ServiceCommandRunner = vi.fn((_file: string, args: readonly string[]) => {
      const showing = args.includes("show");
      return Promise.resolve(showing
        ? { code: 0, stdout: "failed\nfailed\n0\nenabled\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" });
    });
    const manager = createServiceManager({ platform: "linux", home: homeDir, runner }) as SystemdUserAdapter;
    await manager.register(definition);
    expect(await manager.status()).toBe("stopped");
    expect(await manager.detail()).toMatchObject({ loaded: true, running: false, activeState: "failed", enabled: true });
  });

  it("reports label, definition path, and load state separately from runtime readiness", async () => {
    const homeDir = await home();
    const runner: ServiceCommandRunner = vi.fn((_file: string, args: readonly string[]) => {
      const showing = args.includes("show");
      return Promise.resolve(showing
        ? { code: 0, stdout: "active\nrunning\n4242\nenabled\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" });
    });
    const manager = createServiceManager({ platform: "linux", home: homeDir, runner }) as SystemdUserAdapter;
    expect(await manager.detail()).toMatchObject({ registered: false, loaded: false, running: false });
    await manager.register(definition);
    const detail = await manager.detail();
    expect(detail).toMatchObject({
      label: "rly-gateway",
      registered: true,
      loaded: true,
      running: true,
      pid: 4242,
      enabled: true,
    });
    expect(detail.definitionPath).toBe(join(homeDir, ".config", "systemd", "user", "rly-gateway.service"));
  });

  it("fails actionably when no user systemd manager is reachable", async () => {
    const homeDir = await home();
    const runner: ServiceCommandRunner = () => Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "Failed to connect to bus: No such file or directory",
    });
    const manager = createServiceManager({ platform: "linux", home: homeDir, runner });
    await expect(manager.register(definition)).rejects.toThrow(/no reachable systemd user manager/);
    await expect(manager.register(definition)).rejects.toThrow(/enable-linger/);
    await expect(manager.register(definition)).rejects.toThrow(/logged-in terminal session/);
    await expect(manager.start()).rejects.toThrow(/no reachable systemd user manager/);
    // The probe fails before any filesystem write: no half-registered unit.
    expect(await manager.isRegistered()).toBe(false);
  });

  it("reports unknown load state when the manager is unreachable at status time", async () => {
    const homeDir = await home();
    const runner: ServiceCommandRunner = vi.fn((_file: string, args: readonly string[]) => {
      const showing = args.includes("show");
      return Promise.resolve(showing
        ? { code: 1, stdout: "", stderr: "Failed to connect to bus: No such file or directory" }
        : { code: 0, stdout: "", stderr: "" });
    });
    const manager = createServiceManager({ platform: "linux", home: homeDir, runner }) as SystemdUserAdapter;
    await manager.register(definition);
    // The unit file exists, but the manager cannot confirm load state: never
    // reported as loaded/running.
    expect(await manager.detail()).toMatchObject({ registered: true, loaded: false, running: false });
    expect(await manager.status()).toBe("unknown");
  });

  it("restarts the unit through systemctl restart for the #73 restart path", async () => {
    const homeDir = await home();
    const { runner, calls } = runnerMock();
    const manager = createServiceManager({ platform: "linux", home: homeDir, runner }) as SystemdUserAdapter;
    await manager.restart();
    expect(calls.at(-1)?.args).toEqual(["--user", "restart", "rly-gateway.service"]);
  });

  it("stop tolerates an already-stopped unit", async () => {
    const homeDir = await home();
    const runner: ServiceCommandRunner = () => Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "Failed to stop rly-gateway.service: Unit rly-gateway.service not loaded.",
    });
    const manager = createServiceManager({ platform: "linux", home: homeDir, runner });
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it("writes working directory and the RLY log path into the unit", async () => {
    const homeDir = await home();
    const { runner } = runnerMock();
    const manager = createServiceManager({
      platform: "linux",
      home: homeDir,
      runner,
      workingDirectory: join(homeDir, ".rly"),
      logPath: join(homeDir, ".rly", "logs", "service.log"),
    });
    await manager.register(definition);
    const unit = await readFile(join(homeDir, ".config", "systemd", "user", "rly-gateway.service"), "utf8");
    expect(unit).toContain(`WorkingDirectory=${join(homeDir, ".rly")}`);
    expect(unit).toContain(`StandardOutput=append:${join(homeDir, ".rly", "logs", "service.log")}`);
    expect(unit).toContain(`StandardError=append:${join(homeDir, ".rly", "logs", "service.log")}`);
    await expect(stat(join(homeDir, ".rly", "logs"))).resolves.toBeDefined();
  });

  it("unregister disables and removes only the RLY unit", async () => {
    const homeDir = await home();
    const { runner, calls } = runnerMock();
    const manager = createServiceManager({ platform: "linux", home: homeDir, runner });
    await manager.register(definition);
    expect(await manager.isRegistered()).toBe(true);
    await manager.unregister();
    expect(await manager.isRegistered()).toBe(false);
    expect(calls.some((call) => call.args.includes("disable") && call.args.includes("--now"))).toBe(true);
    await expect(readFile(join(homeDir, ".config", "systemd", "user", "rly-gateway.service"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(typeof process.getuid !== "function")("refuses to run as root", async () => {
    const homeDir = await home();
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(0);
    try {
      const manager = createServiceManager({ platform: "linux", home: homeDir, runner: runnerMock().runner });
      await expect(manager.register(definition)).rejects.toThrow(/must not run as root/);
    } finally {
      getuid.mockRestore();
    }
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
