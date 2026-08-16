import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SystemdUserAdapter } from "../../src/service-manager/systemd-user.js";
import type { ServiceDefinitionInput } from "../../src/service-manager/types.js";

/**
 * Linux-only opt-in smoke that proves real systemd user mechanics: probe ->
 * register (daemon-reload) -> enable/start -> running -> restart -> stop ->
 * unregister.
 *
 * Requires a logged-in user session with a reachable systemd user manager
 * (user D-Bus), so CI containers, minimal distros, and WSL without systemd
 * must not run it. Gated on `RLY_LIVE_SYSTEMD_SMOKE=1`; a skipped scenario is
 * not passing evidence. Runtime `/identity` readiness is covered separately by
 * `tests/lifecycle/resident-runtime.test.ts` with fake servers — this smoke
 * only proves the systemd adapter lifecycle against the real system.
 */
const enabled = process.platform === "linux" && process.env.RLY_LIVE_SYSTEMD_SMOKE === "1";
const SMOKE_SERVICE_NAME = "rly-gateway.smoke";

describe.skipIf(!enabled)("Linux systemd user live smoke (opt-in RLY_LIVE_SYSTEMD_SMOKE=1)", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() >= deadline) throw new Error(message);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  it("registers, enables/starts, restarts, stops, and unregisters a real systemd user unit", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "rly-systemd-smoke-"));
    directories.push(scratch);
    const entrypoint = join(scratch, "entrypoint.mjs");
    await writeFile(entrypoint, "setInterval(() => {}, 1000);\n");
    const configPath = join(scratch, "gateway.config.toml");
    await writeFile(configPath, "# smoke fixture\n");
    const manager = new SystemdUserAdapter({
      home: homedir(),
      serviceName: SMOKE_SERVICE_NAME,
      workingDirectory: scratch,
      logPath: join(scratch, "service.log"),
    });
    const definition: ServiceDefinitionInput = {
      serviceName: SMOKE_SERVICE_NAME,
      executable: process.execPath,
      entrypoint,
      configPath,
    };
    try {
      await manager.unregister().catch(() => undefined);
      await manager.register(definition);
      expect(await manager.isRegistered()).toBe(true);
      await manager.start();
      await waitFor(async () => (await manager.detail()).running, 15_000, "enable/start did not reach a running state");
      expect((await manager.detail()).loaded).toBe(true);
      expect((await manager.detail()).enabled).toBe(true);
      expect(typeof (await manager.detail()).pid).toBe("number");

      await manager.restart();
      await waitFor(async () => (await manager.detail()).running, 15_000, "restart did not return to a running state");

      // #94: the rendered unit is the stable RLY bootstrap contract — no
      // dist/cli/init.js, no Node binary path, no direct runtime/refs/... path.
      const rendered = manager.renderDefinition(definition);
      expect(rendered).toContain(process.execPath);
      expect(rendered).toContain(entrypoint);
      expect(rendered).not.toMatch(/dist[/\\]cli[/\\]init\.js/);
      expect(rendered).not.toMatch(/runtime[/\\]refs[/\\]/);

      await manager.stop();
      const stopped = await manager.detail();
      expect(stopped.running).toBe(false);
      expect(await manager.status()).toBe("stopped"); // registered unit, stopped service
    } finally {
      await manager.unregister().catch(() => undefined);
      expect(await manager.isRegistered()).toBe(false);
    }
  });

  it("bootstraps the stable RLY bootstrap script as the sole ExecStart (#94)", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "rly-systemd-bootstrap-smoke-"));
    directories.push(scratch);
    const marker = join(scratch, "booted.marker");
    const bootstrap = join(scratch, "rly-gateway");
    await writeFile(bootstrap, `#!/bin/sh\nprintf '%s\\n' "$*" > "${marker}"\nexec "${process.execPath}" -e "setInterval(() => {}, 1000)"\n`, { mode: 0o755 });
    const configPath = join(scratch, "gateway.config.toml");
    await writeFile(configPath, "# smoke fixture\n");
    const manager = new SystemdUserAdapter({
      home: homedir(),
      serviceName: `${SMOKE_SERVICE_NAME}.bootstrap`,
      workingDirectory: scratch,
      logPath: join(scratch, "service.log"),
    });
    const definition: ServiceDefinitionInput = {
      serviceName: `${SMOKE_SERVICE_NAME}.bootstrap`,
      executable: bootstrap,
      configPath,
    };
    try {
      await manager.unregister().catch(() => undefined);
      await manager.register(definition);
      await manager.start();
      await waitFor(async () => (await manager.detail()).running, 15_000, "bootstrap script did not reach a running state");
      // The bootstrap received the gateway start contract arguments.
      await waitFor(async () => {
        const contents = await import("node:fs/promises").then((m) => m.readFile(marker, "utf8").catch(() => ""));
        return contents.includes("gateway start --config");
      }, 5_000, "bootstrap did not receive the gateway start contract");
    } finally {
      await manager.unregister().catch(() => undefined);
      expect(await manager.isRegistered()).toBe(false);
    }
  });
});
