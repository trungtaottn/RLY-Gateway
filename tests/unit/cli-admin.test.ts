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
import { directProviderRegistry } from "../../src/registry/model-registry.js";

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
    expect(parseCliArgs([
      "admin", "providers", "create", "--name", "cline", "--mode", "oauth", "--endpoint", "https://example.invalid/clinepass", "--config", "gateway.toml",
    ], "/work")).toMatchObject({
      command: "admin",
      resource: "providers",
      action: "create",
      fields: { name: "cline", mode: "oauth", endpoint: "https://example.invalid/clinepass" },
    });
    expect(parseCliArgs(["admin", "accounts", "pause", "--id", "acct", "--version", "2"], "/work")).toMatchObject({
      resource: "accounts",
      action: "pause",
      fields: { id: "acct", version: "2" },
    });
    expect(parseCliArgs(["admin", "ui"], "/work")).toMatchObject({ resource: "ui", action: "open" });
    expect(parseCliArgs(["serve"])).toMatchObject({ command: "run-claude", profile: "serve" });
    const pause = parseAdminArgs(["admin", "providers", "pause", "--id", "x", "--version", "1"], "/work/gateway.toml");
    if (!pause) throw new Error("expected admin command");
    await expect(runAdmin(pause, gatewayConfigSchema.parse({ schemaVersion: 1, gateway: {} }))).rejects.toThrow("pause and resume apply only to accounts");
  });

  it("parses models refresh and proposals commands without a serve surface", () => {
    expect(parseCliArgs([
      "admin", "models", "refresh", "--provider", "openrouter", "--config", "gateway.toml",
    ], "/work")).toMatchObject({
      command: "admin",
      resource: "models",
      action: "refresh",
      fields: { provider: "openrouter" },
    });
    expect(parseCliArgs(["admin", "models", "proposals", "--config", "gateway.toml"], "/work")).toMatchObject({
      command: "admin",
      resource: "models",
      action: "proposals",
    });
    expect(() => parseAdminArgs(["admin", "models", "list"], "/work/gateway.toml")).toThrow(/not valid for models/);
  });

  it("refreshes a static catalog into a proposal without touching trusted evidence or the management API", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-admin-models-"));
    directories.push(directory);
    const snapshotPath = join(directory, "snapshot.json");
    await writeFile(snapshotPath, JSON.stringify({
      source: "reviewed-list",
      discoveredAt: "2026-08-22T00:00:00.000Z",
      models: [
        { accessProviderId: "openrouter", upstreamModelId: "nvidia/nemotron-3.5-lightning:free", modelFamily: "nvidia" },
        { accessProviderId: "openrouter", upstreamModelId: "new/candidate:free", modelFamily: "new" },
      ],
    }), "utf8");
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, `schemaVersion = 1\n[gateway]\nport = 17871\n[controlPlane]\ndataDirectory = ${JSON.stringify(directory)}\n`, "utf8");
    const trustedBefore = directProviderRegistry.models;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runCli([
        "admin", "models", "refresh", "--provider", "openrouter", "--source", "static",
        "--snapshot", snapshotPath, "--config", configPath,
      ])).resolves.toBe(0);
      const printed = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        ok: boolean; trusted: boolean; report: { new: unknown[]; unchanged: unknown[] };
      };
      expect(printed.ok).toBe(true);
      expect(printed.trusted).toBe(false);
      expect(printed.report.new).toHaveLength(1);
      expect(printed.report.unchanged).toHaveLength(1);
      // Trusted evidence is untouched by refresh.
      expect(directProviderRegistry.models).toBe(trustedBefore);
      expect(Object.isFrozen(directProviderRegistry.models)).toBe(true);

      await expect(runCli(["admin", "models", "proposals", "--config", configPath])).resolves.toBe(0);
      const listed = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        ok: boolean; trusted: boolean; proposals: Array<{ providerId: string }>;
      };
      expect(listed.ok).toBe(true);
      expect(listed.trusted).toBe(false);
      expect(listed.proposals.map((proposal) => proposal.providerId)).toEqual(["openrouter"]);
      // Proposals are surfaced but never represented as trusted/selectable.
      expect(JSON.stringify(printed)).not.toContain('"trusted":true');
    } finally {
      log.mockRestore();
    }
  });

  it("requires a provider for models refresh", async () => {
    const command = parseAdminArgs(["admin", "models", "refresh"], "/work/gateway.toml");
    if (!command) throw new Error("expected admin command");
    await expect(runAdmin(command, gatewayConfigSchema.parse({ schemaVersion: 1, gateway: {} }))).rejects.toThrow(/requires --provider/);
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
      await expect(runCli([
        "admin", "providers", "create", "--name", "cline", "--mode", "oauth",
        "--endpoint", "https://example.invalid/clinepass", "--config", configPath,
      ])).resolves.toBe(0);
      await expect(runCli(["admin", "providers", "list", "--config", configPath])).resolves.toBe(0);
      const listed = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(listed).toContain("openrouter");
      expect(listed).toContain("cline");
      expect(listed).toContain("https://example.invalid/clinepass");
    } finally {
      log.mockRestore();
      await lease.release();
    }
  });
});
