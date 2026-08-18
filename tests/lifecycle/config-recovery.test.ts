import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfig } from "../../src/cli/config.js";
import { parseCliArgs } from "../../src/cli/main.js";
import { readManagementToken } from "../../src/cli/management-client.js";
import { loadConfig } from "../../src/config/load-config.js";
import { gatewayConfigSchema } from "../../src/config/schema.js";
import { inspectRuntimeGateway } from "../../src/runtime/gateway-lifecycle.js";
import { startResidentRuntime } from "../../src/runtime/resident-runtime.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-config-life-"));
  directories.push(path);
  return path;
}

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

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("rly config lifecycle with the resident runtime", () => {
  it("reuses a real resident runtime, prints a headless bootstrap URL, and leaves the runtime running", async () => {
    const dir = await directory();
    const port = await availablePort();
    const managementPort = await availablePort();
    const configPath = join(dir, "gateway.toml");
    await writeFile(configPath, `schemaVersion = 1\n[gateway]\nport = ${String(port)}\nmanagementPort = ${String(managementPort)}\nlogLevel = "silent"\n`, "utf8");
    const config = gatewayConfigSchema.parse({
      schemaVersion: 1,
      gateway: { port, managementPort, logLevel: "silent" },
    });

    const handle = await startResidentRuntime({
      config,
      controlPlaneDirectory: join(dir, "control-plane"),
    });
    try {
      // `rly config` from an unrelated cwd reaches the resident runtime through
      // the management listener and never stops it.
      const output = vi.fn();
      vi.spyOn(console, "log").mockImplementation(output);
      try {
        const command = parseCliArgs(["config", "ui", "--headless", "--config", configPath], "/unrelated/dir");
        if (!command || command.command !== "config") throw new Error("expected config command");
        const code = await runConfig(command);
        expect(code).toBe(0);
        const printed = output.mock.calls.map((call) => String(call[0])).join("\n");
        expect(printed).toContain(`"url":"http://127.0.0.1:${String(managementPort)}/#t=`);
        expect(printed).toContain('"headless":true');
      } finally {
        output.mockRestore();
      }

      // Closing the config UI does not stop the resident runtime.
      const after = await inspectRuntimeGateway(config);
      expect(after.state).toBe("attested-compatible");
      if (after.state === "attested-compatible") expect(after.resident).toBe(true);

      // The status surface observes the same runtime the service owns.
      const statusOutput = vi.fn();
      vi.spyOn(console, "log").mockImplementation(statusOutput);
      try {
        const command = parseCliArgs(["config", "status", "--config", configPath], "/unrelated/dir");
        if (!command || command.command !== "config") throw new Error("expected config command");
        const code = await runConfig(command);
        expect(code).toBe(0);
        const status = JSON.parse(String(statusOutput.mock.calls[0]?.[0])) as {
          ok: boolean; runtime: { state: string; resident: boolean };
        };
        expect(status.ok).toBe(true);
        expect(status.runtime.state).toBe("attested-compatible");
        expect(status.runtime.resident).toBe(true);
      } finally {
        statusOutput.mockRestore();
      }
    } finally {
      await handle.shutdown();
      await handle.stopped;
    }
  });

  it("observes one policy revision after a config mutation, shared with the admin surface", async () => {
    const dir = await directory();
    const port = await availablePort();
    const managementPort = await availablePort();
    const configPath = join(dir, "gateway.toml");
    await writeFile(configPath, `schemaVersion = 1\n[gateway]\nport = ${String(port)}\nmanagementPort = ${String(managementPort)}\nlogLevel = "silent"\n`, "utf8");
    const config = await loadConfig(configPath);
    const handle = await startResidentRuntime({ config, controlPlaneDirectory: join(dir, "control-plane") });
    const output = vi.fn();
    vi.spyOn(console, "log").mockImplementation(output);
    try {
      const command = parseCliArgs([
        "config", "providers", "create", "--name", "openrouter", "--mode", "direct", "--config", configPath,
      ], "/unrelated/dir");
      if (!command || command.command !== "config") throw new Error("expected config command");
      await expect(runConfig(command)).resolves.toBe(0);

      // `rly admin` and the management API read the same policy revision the
      // `rly config` mutation just published: one source of truth.
      const token = await readManagementToken(config);
      if (!token) throw new Error("expected a management token");
      const response = await fetch(
        `http://127.0.0.1:${String(managementPort)}/v1/policy`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
      const policy = await response.json() as { revision: number; providers: Array<{ name: string }> };
      expect(policy.revision).toBe(1);
      expect(policy.providers.map((provider) => provider.name)).toEqual(["openrouter"]);
      expect(JSON.stringify(policy)).not.toContain("accessToken");
      expect(JSON.stringify(policy)).not.toContain("authorization");
    } finally {
      output.mockRestore();
      await handle.shutdown();
      await handle.stopped;
    }
  });
});
