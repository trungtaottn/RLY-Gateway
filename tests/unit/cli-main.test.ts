import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { childExitCode, parseCliArgs, runCli } from "../../src/cli/main.js";

describe("CLI parsing", () => {
  it("forwards only arguments after the run separator to Claude", () => {
    expect(parseCliArgs([
      "run", "claude", "--config", "custom.toml", "--", "--model", "name with spaces", "--dangerously-skip-permissions",
    ], "/work")).toEqual({
      command: "run-claude",
      configPath: "/work/custom.toml",
      claudeArgs: ["--model", "name with spaces", "--dangerously-skip-permissions"],
    });
  });

  it("requires an explicit separator for Claude arguments", () => {
    expect(() => parseCliArgs(["run", "claude", "--model", "model"])).toThrow("requires `--`");
  });

  it("pins a configured exact provider/model route through its explicit role", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-gateway-cli-route-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n[routes.primary]\nprovider = \"openrouter\"\nmodel = \"provider/model\"\ncredential = \"env:OPENROUTER_API_KEY\"\n", "utf8");
    expect(parseCliArgs(["run", "claude", "--config", configPath, "--route", "openrouter/provider/model", "--", "-p", "fixture"])).toMatchObject({ route: "openrouter/provider/model" });
    const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const launch = vi.fn().mockResolvedValue({ code: 0, signal: null });
    await expect(runCli(
      ["run", "claude", "--config", configPath, "--route", "openrouter/provider/model", "--", "-p", "fixture"],
      { environment: { PATH: "/bin" }, acquireGateway: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:17871", authToken: "transient", instanceId: "00000000-0000-4000-8000-000000000001", leaseId: "00000000-0000-4000-8000-000000000011", reused: false, release }), launchClaude: launch },
    )).resolves.toBe(0);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ args: ["--model", "primary", "-p", "fixture"] }));
  });

  it("rejects unconfigured or conflicting route selection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-gateway-cli-route-error-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    await expect(runCli(["run", "claude", "--config", configPath, "--route", "openrouter/missing", "--"], { environment: {} })).rejects.toThrow("not configured");
    expect(() => parseCliArgs(["run", "claude", "--route", "openrouter/model", "--", "--model", "primary"])).not.toThrow();
  });

  it("does not expose an ownership-bypassing serve command", () => {
    expect(parseCliArgs(["serve"])).toBeUndefined();
  });

  it("preserves regular child exits and converts signal exits", () => {
    expect(childExitCode({ code: 7, signal: null })).toBe(7);
    expect(childExitCode({ code: null, signal: "SIGINT" })).toBe(130);
  });

  it("acquires and releases a gateway around the Claude child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-gateway-cli-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const acquire = vi.fn().mockResolvedValue({
      baseUrl: "http://127.0.0.1:17871",
      authToken: "transient",
      instanceId: "00000000-0000-4000-8000-000000000001",
      leaseId: "00000000-0000-4000-8000-000000000011",
      reused: false,
      release,
    });
    const launch = vi.fn().mockResolvedValue({ code: 0, signal: null });
    await expect(runCli(
      ["run", "claude", "--config", configPath, "--", "--model", "test"],
      { environment: { PATH: "/bin" }, acquireGateway: acquire, launchClaude: launch },
    )).resolves.toBe(0);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      gatewayBaseUrl: "http://127.0.0.1:17871",
      authToken: "transient",
      args: ["--model", "test"],
    }));
    expect(release).toHaveBeenCalledOnce();
  });
});
