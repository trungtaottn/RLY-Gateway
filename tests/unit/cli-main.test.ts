import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { childExitCode, parseCliArgs, runCli } from "../../src/cli/main.js";
import { ProfileActivationError } from "../../src/profiles/errors.js";

describe("CLI parsing", () => {
  it("parses quota and route-trace diagnostic commands", () => {
    expect(parseCliArgs(["quota", "--config", "custom.toml"], "/work")).toEqual({
      command: "quota",
      configPath: "/work/custom.toml",
    });
    expect(parseCliArgs(["route-trace"], "/work")).toEqual({
      command: "route-trace",
      configPath: "/work/gateway.config.toml",
    });
  });

  it("parses run codex with the same separator contract", () => {
    expect(parseCliArgs(["run", "codex", "--config", "custom.toml", "--", "exec", "fixture"], "/work")).toEqual({
      command: "run-codex",
      configPath: "/work/custom.toml",
      claudeArgs: ["exec", "fixture"],
    });
  });

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
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cli-route-"));
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
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cli-route-error-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    await expect(runCli(["run", "claude", "--config", configPath, "--route", "openrouter/missing", "--"], { environment: {} })).rejects.toThrow("not configured");
    expect(() => parseCliArgs(["run", "claude", "--route", "openrouter/model", "--", "--model", "primary"])).not.toThrow();
  });

  it("parses --profile and rejects combining it with --route", () => {
    expect(parseCliArgs(["run", "claude", "--profile", "work", "--", "-p", "fixture"])).toMatchObject({
      command: "run-claude",
      profile: "work",
    });
    expect(() => parseCliArgs(["run", "claude", "--profile", "work", "--route", "openrouter/model", "--"])).toThrow("cannot be combined");
  });

  it("launches Claude with a profile child token instead of the instance secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cli-profile-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const launch = vi.fn().mockResolvedValue({ code: 0, signal: null });
    await expect(runCli(
      ["run", "claude", "--config", configPath, "--profile", "work", "--", "-p", "fixture"],
      {
        environment: { PATH: "/bin" },
        acquireGateway: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:17871",
          authToken: "instance-secret",
          instanceId: "00000000-0000-4000-8000-000000000001",
          leaseId: "00000000-0000-4000-8000-000000000011",
          reused: false,
          release,
        }),
        launchClaude: launch,
        issueProfileLaunch: vi.fn().mockResolvedValue({ token: "child-token", args: ["-p", "fixture"], executable: "claude" }),
      },
    )).resolves.toBe(0);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ authToken: "child-token", args: ["-p", "fixture"] }));
    expect(release).toHaveBeenCalledOnce();
  });

  it("parses a bare profile as Claude Code launch, not Codex CLI", () => {
    expect(parseCliArgs(["codex"], "/work")).toEqual({
      command: "run-claude",
      configPath: "/work/gateway.config.toml",
      claudeArgs: [],
      profile: "codex",
    });
    expect(parseCliArgs(["clinepass", "--config", "custom.toml", "--", "-p", "fixture"], "/work")).toEqual({
      command: "run-claude",
      configPath: "/work/custom.toml",
      claudeArgs: ["-p", "fixture"],
      profile: "clinepass",
    });
    expect(parseCliArgs(["deepseek"])).not.toMatchObject({ command: "run-codex" });
  });

  it("keeps reserved commands from colliding with profile names", () => {
    expect(parseCliArgs(["status"], "/work")).toMatchObject({ command: "status" });
    expect(parseCliArgs(["doctor"], "/work")).toMatchObject({ command: "doctor" });
    expect(parseCliArgs(["quota"], "/work")).toMatchObject({ command: "quota" });
    expect(parseCliArgs(["route-trace"], "/work")).toMatchObject({ command: "route-trace" });
    expect(parseCliArgs(["admin", "ui"], "/work")).toMatchObject({ command: "admin", resource: "ui" });
    expect(parseCliArgs(["run", "codex", "--"], "/work")).toMatchObject({ command: "run-codex", claudeArgs: [] });
    expect(parseCliArgs(["run", "claude", "--profile", "codex", "--"], "/work")).toMatchObject({
      command: "run-claude",
      profile: "codex",
    });
  });

  it("rejects --profile or leftover tokens on a bare profile", () => {
    expect(() => parseCliArgs(["codex", "--profile", "work"])).toThrow("cannot be combined with a bare profile name");
    expect(() => parseCliArgs(["codex", "--route", "openrouter/model"])).toThrow("cannot be combined");
    expect(() => parseCliArgs(["codex", "-p", "fixture"])).toThrow("unknown option");
    expect(() => parseCliArgs(["codex", "extra"])).toThrow("requires `--`");
  });

  it("launches Claude Code for a bare profile with a child token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cli-bare-profile-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const launchClaude = vi.fn().mockResolvedValue({ code: 0, signal: null });
    const launchCodex = vi.fn().mockResolvedValue({ code: 0, signal: null });
    const issueProfileLaunch = vi.fn().mockResolvedValue({ token: "child-token", args: ["-p", "fixture"], executable: "claude" });
    await expect(runCli(
      ["codex", "--config", configPath, "--", "-p", "fixture"],
      {
        environment: { PATH: "/bin" },
        acquireGateway: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:17871",
          authToken: "instance-secret",
          instanceId: "00000000-0000-4000-8000-000000000001",
          leaseId: "00000000-0000-4000-8000-000000000011",
          reused: false,
          release,
        }),
        launchClaude,
        launchCodex,
        issueProfileLaunch,
      },
    )).resolves.toBe(0);
    expect(issueProfileLaunch).toHaveBeenCalledWith(expect.anything(), "codex", ["-p", "fixture"], expect.anything(), "claude");
    expect(launchClaude).toHaveBeenCalledWith(expect.objectContaining({ authToken: "child-token", args: ["-p", "fixture"] }));
    expect(launchCodex).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails closed on an unknown bare profile and does not launch Codex CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cli-unknown-profile-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const launchCodex = vi.fn();
    await expect(runCli(
      ["missing", "--config", configPath],
      {
        environment: { PATH: "/bin" },
        acquireGateway: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:17871",
          authToken: "instance-secret",
          instanceId: "00000000-0000-4000-8000-000000000001",
          leaseId: "00000000-0000-4000-8000-000000000011",
          reused: false,
          release,
        }),
        launchClaude: vi.fn(),
        launchCodex,
        issueProfileLaunch: vi.fn().mockRejectedValue(new ProfileActivationError("profile-not-found", "Unknown profile")),
      },
    )).rejects.toThrow(ProfileActivationError);
    expect(launchCodex).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not expose an ownership-bypassing serve command", () => {
    expect(parseCliArgs(["serve"])).toMatchObject({ command: "run-claude", profile: "serve" });
    expect(parseCliArgs(["serve"])).not.toMatchObject({ command: "admin" });
  });

  it("prints the canonical rly executable in usage output", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(runCli([], { environment: {} })).resolves.toBe(2);
    expect(output).toHaveBeenCalledWith(expect.stringContaining("Usage: rly "));
    output.mockRestore();
  });

  it("preserves regular child exits and converts signal exits", () => {
    expect(childExitCode({ code: 7, signal: null })).toBe(7);
    expect(childExitCode({ code: null, signal: "SIGINT" })).toBe(130);
  });

  it("acquires and releases a gateway around the Claude child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cli-"));
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
