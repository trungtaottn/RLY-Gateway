import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LaunchAgentAdapter } from "../../src/service-manager/launch-agent.js";
import type { ServiceDefinitionInput } from "../../src/service-manager/types.js";

/**
 * macOS-only opt-in smoke that proves real launchd mechanics: bootstrap ->
 * process running -> idempotent start -> restart -> stop -> unregister.
 *
 * Requires a logged-in GUI user session (launchd `gui/<uid>` domain), so CI
 * without one must not run it. Gated on `RLY_LIVE_LAUNCHAGENT_SMOKE=1`; a
 * skipped scenario is not passing evidence. Runtime `/identity` readiness is
 * covered separately by `tests/lifecycle/resident-runtime.test.ts` with fake
 * servers — this smoke only proves the launchd adapter lifecycle against the
 * real system.
 */
const enabled = process.platform === "darwin" && process.env.RLY_LIVE_LAUNCHAGENT_SMOKE === "1";
const SMOKE_LABEL = "com.rly.gateway.smoke";

describe.skipIf(!enabled)("macOS launchd live smoke (opt-in RLY_LIVE_LAUNCHAGENT_SMOKE=1)", () => {
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

  it("bootstraps, runs, restarts, stops, and unregisters a real LaunchAgent", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "rly-launchd-smoke-"));
    directories.push(scratch);
    const entrypoint = join(scratch, "entrypoint.mjs");
    await writeFile(entrypoint, "setInterval(() => {}, 1000);\n");
    const configPath = join(scratch, "gateway.config.toml");
    await writeFile(configPath, "# smoke fixture\n");
    const manager = new LaunchAgentAdapter({
      home: homedir(),
      label: SMOKE_LABEL,
      workingDirectory: scratch,
      logPath: join(scratch, "service.log"),
    });
    const definition: ServiceDefinitionInput = {
      serviceName: SMOKE_LABEL,
      executable: process.execPath,
      entrypoint,
      configPath,
    };
    try {
      await manager.unregister().catch(() => undefined);
      await manager.register(definition);
      expect(await manager.isRegistered()).toBe(true);
      await waitFor(async () => (await manager.detail()).running, 10_000, "bootstrap did not reach a running state");
      expect((await manager.detail()).loaded).toBe(true);
      expect(typeof (await manager.detail()).pid).toBe("number");

      await manager.start();
      await waitFor(async () => (await manager.detail()).running, 10_000, "start did not leave the job running");
      await manager.restart();
      await waitFor(async () => (await manager.detail()).running, 10_000, "restart did not return to a running state");

      await manager.stop();
      const stopped = await manager.detail();
      expect(stopped.loaded).toBe(false);
      expect(stopped.running).toBe(false);
      expect(await manager.status()).toBe("stopped"); // registered plist, unloaded job
    } finally {
      await manager.unregister().catch(() => undefined);
      expect(await manager.isRegistered()).toBe(false);
    }
  });
});
