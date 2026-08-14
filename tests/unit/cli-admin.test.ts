import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAdminArgs, runAdmin } from "../../src/cli/admin.js";
import { parseCliArgs, runCli } from "../../src/cli/main.js";
import { gatewayConfigSchema } from "../../src/config/schema.js";
import { loadConfig } from "../../src/config/load-config.js";
import { acquireGateway } from "../../src/runtime/gateway-lifecycle.js";

const directories: string[] = [];

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
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("admin CLI parsing", () => {
  it("parses create, pause, and ui commands without a serve surface", async () => {
    expect(parseCliArgs([
      "admin", "providers", "create", "--name", "codex", "--mode", "oauth", "--config", "gateway.toml",
    ], "/work")).toMatchObject({
      command: "admin",
      resource: "providers",
      action: "create",
      fields: { name: "codex", mode: "oauth" },
    });
    expect(parseCliArgs(["admin", "accounts", "pause", "--id", "acct", "--version", "2"], "/work")).toMatchObject({
      resource: "accounts",
      action: "pause",
      fields: { id: "acct", version: "2" },
    });
    expect(parseCliArgs(["admin", "ui"], "/work")).toMatchObject({ resource: "ui", action: "open" });
    expect(parseCliArgs(["serve"])).toBeUndefined();
    const pause = parseAdminArgs(["admin", "providers", "pause", "--id", "x", "--version", "1"], "/work/gateway.toml");
    if (!pause) throw new Error("expected admin command");
    await expect(runAdmin(pause, gatewayConfigSchema.parse({ schemaVersion: 1, gateway: {} }))).rejects.toThrow("pause and resume apply only to accounts");
  });

  it("creates and lists providers through the live management listener", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-admin-cli-"));
    directories.push(directory);
    const port = await availablePort();
    const managementPort = await availablePort();
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, `schemaVersion = 1\n[gateway]\nport = ${String(port)}\nmanagementPort = ${String(managementPort)}\nlogLevel = "silent"\n`, "utf8");
    const lease = await acquireGateway({
      config: await loadConfig(configPath),
      controlPlaneDirectory: join(directory, "control-plane"),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runCli(["admin", "providers", "create", "--name", "openrouter", "--mode", "direct", "--config", configPath])).resolves.toBe(0);
      await expect(runCli(["admin", "providers", "list", "--config", configPath])).resolves.toBe(0);
      const listed = log.mock.calls.map((call) => String(call[0])).find((line) => line.includes("openrouter"));
      expect(listed).toContain("openrouter");
    } finally {
      log.mockRestore();
      await lease.release();
    }
  });
});
