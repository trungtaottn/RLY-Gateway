#!/usr/bin/env node
import { constants as osConstants, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAdminArgs, runAdmin, type AdminCommand } from "./admin.js";
import { parseConfigArgs, runConfig, type ConfigCommand } from "./config.js";
import { runDoctor, runQuota, runRouteTrace, runStatus } from "./diagnostics.js";
import { runGatewayCommand, type GatewayAction } from "./gateway.js";
import { runInit } from "./init.js";
import { loadConfig } from "../config/load-config.js";
import { ProfileActivationError } from "../profiles/errors.js";
import { launchClaude, launchCodex, type ChildExit, type LaunchClaudeOptions } from "../runtime/child-launcher.js";
import { prepareClaudeOverlay, type ClaudeOverlayResolution } from "../runtime/claude-overlay.js";
import { acquireGateway, type GatewayLeaseHandle } from "../runtime/gateway-lifecycle.js";
import { detectClaudeTarget, detectCodexTarget } from "../targets/detect.js";
import { RLY_STATE_DIRECTORY_NAME } from "../storage/paths.js";

const DEFAULT_CONFIG = "gateway.config.toml";
const DIAGNOSTIC_COMMANDS = ["status", "doctor", "quota", "route-trace"] as const;
const ACTIVATION_CODES = [
  "profile-not-found",
  "profile-not-claude",
  "profile-has-no-pool",
  "role-unmapped",
  "capability-rejected",
  "invalid-launch-policy",
] as const satisfies readonly ProfileActivationError["code"][];
const ROUTE_ROLES = ["primary", "fast", "reasoning"] as const;

function usage(): void {
  console.log("Usage: rly <profile> [--config path] [--] [claude args] | rly <status|doctor|quota|route-trace> [--config path] | admin <providers|accounts|pools|profiles|credentials|ui|models> ... [--config path] | run <claude|codex> [--config path] [--profile name | --route provider/model] -- [harness args] | rly init [--config path] | rly gateway <start|stop|status> [--config path] | rly config [status|ui|providers|accounts|pools|profiles ...] [--config path] [--headless]");
}

export type ParsedCliCommand =
  | Readonly<{ command: "status" | "doctor" | "quota" | "route-trace"; configPath: string }>
  | Readonly<{ command: "run-claude" | "run-codex"; configPath: string; claudeArgs: readonly string[]; route?: string; profile?: string }>
  | Readonly<{ command: "init"; configPath: string }>
  | Readonly<{ command: "gateway"; action: GatewayAction; configPath: string }>
  | AdminCommand
  | ConfigCommand;

function isDiagnosticCommand(value: string | undefined): value is "status" | "doctor" | "quota" | "route-trace" {
  return value !== undefined && (DIAGNOSTIC_COMMANDS as readonly string[]).includes(value);
}

function configPath(args: readonly string[], cwd: string): string {
  const index = args.indexOf("--config");
  const configuredPath = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && configuredPath === undefined) throw new Error("--config requires a path");
  return resolve(cwd, configuredPath ?? DEFAULT_CONFIG);
}

function optionalFlag(options: readonly string[], flag: string, missing: string): string | undefined {
  const index = options.indexOf(flag);
  if (index < 0) return undefined;
  const value = options[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(missing);
  if (options.filter((item) => item === flag).length !== 1) throw new Error(`${flag} may be provided once`);
  return value;
}

function isActivationCode(value: unknown): value is ProfileActivationError["code"] {
  return typeof value === "string" && (ACTIVATION_CODES as readonly string[]).includes(value);
}

function throwActivationFailure(payload: unknown): never {
  const code = payload !== null && typeof payload === "object" && "error" in payload
    ? (payload as { error?: unknown }).error
    : undefined;
  if (isActivationCode(code)) {
    throw new ProfileActivationError(code, code === "profile-not-found" ? "Unknown profile" : "Profile cannot be activated");
  }
  throw new Error("Profile activation failed");
}

function assertBareProfileOptions(options: readonly string[]): void {
  let index = 0;
  while (index < options.length) {
    const token = options[index];
    if (token === undefined) throw new Error("bare profile requires `--` before Claude arguments");
    if (token === "--profile") throw new Error("--profile cannot be combined with a bare profile name");
    if (token === "--route") throw new Error("--profile cannot be combined with --route");
    if (token === "--config") {
      const value = options[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--config requires a path");
      index += 2;
      continue;
    }
    if (token.startsWith("-")) throw new Error(`unknown option ${token}`);
    throw new Error("bare profile requires `--` before Claude arguments");
  }
  if (options.filter((item) => item === "--config").length > 1) throw new Error("--config may be provided once");
}

function parseRunCommand(args: readonly string[], cwd: string): ParsedCliCommand | undefined {
  const harness = args[1];
  if (harness !== "claude" && harness !== "codex") return undefined;
  const separator = args.indexOf("--", 2);
  if (separator < 0) throw new Error(`run ${harness} requires \`--\` before ${harness} arguments`);
  const options = args.slice(2, separator);
  const route = optionalFlag(options, "--route", "--route requires an exact provider/model value");
  const profile = optionalFlag(options, "--profile", "--profile requires a profile name");
  if (route !== undefined && profile !== undefined) throw new Error("--profile cannot be combined with --route");
  return {
    command: harness === "codex" ? "run-codex" : "run-claude",
    configPath: configPath(options, cwd),
    claudeArgs: args.slice(separator + 1),
    ...(route === undefined ? {} : { route }),
    ...(profile === undefined ? {} : { profile }),
  };
}

function parseBareProfileCommand(profile: string, args: readonly string[], cwd: string): ParsedCliCommand {
  const separator = args.indexOf("--", 1);
  const options = separator < 0 ? args.slice(1) : args.slice(1, separator);
  assertBareProfileOptions(options);
  return {
    command: "run-claude",
    configPath: configPath(options, cwd),
    claudeArgs: separator < 0 ? [] : args.slice(separator + 1),
    profile,
  };
}

/** Parses gateway arguments and leaves all arguments after `--` untouched for Claude. */
export function parseCliArgs(args: readonly string[], cwd = process.cwd()): ParsedCliCommand | undefined {
  const [command] = args;
  if (isDiagnosticCommand(command)) {
    return { command, configPath: configPath(args.slice(1), cwd) };
  }
  if (command === "admin") {
    return parseAdminArgs(args.filter((value, index, all) => value !== "--config" && all[index - 1] !== "--config"), configPath(args, cwd));
  }
  if (command === "config") return parseConfigArgs(args, cwd);
  if (command === "run") return parseRunCommand(args, cwd);
  if (command === "init") {
    const rest = args.slice(1);
    if (rest.length > 0 && rest[0] !== "--config") throw new Error("init accepts only --config");
    return { command: "init", configPath: configPath(rest, cwd) };
  }
  if (command === "gateway") {
    const rest = args.slice(1);
    const action = rest[0];
    if (action !== "start" && action !== "stop" && action !== "status") {
      throw new Error("gateway requires start, stop, or status");
    }
    const options = rest.slice(1);
    if (options.length > 0 && options[0] !== "--config") throw new Error(`unknown option ${String(options[0])}`);
    return { command: "gateway", action, configPath: configPath(options, cwd) };
  }
  if (command === undefined || command.startsWith("-")) return undefined;
  return parseBareProfileCommand(command, args, cwd);
}

function configuredRoleForRoute(config: Awaited<ReturnType<typeof loadConfig>>, route: string): "primary" | "fast" | "reasoning" {
  for (const role of ROUTE_ROLES) {
    const candidate = config.routes[role];
    if (candidate !== undefined && `${candidate.provider}/${candidate.model}` === route) return role;
  }
  throw new Error("Requested route is not configured");
}

function routeScopedClaudeArgs(args: readonly string[], role: "primary" | "fast" | "reasoning"): readonly string[] {
  if (args.includes("--model")) throw new Error("--model cannot be combined with gateway --route");
  return ["--model", role, ...args];
}

function detectForHarness(harness: "claude" | "codex"): typeof detectClaudeTarget {
  return harness === "codex" ? detectCodexTarget : detectClaudeTarget;
}

async function issueProfileLaunch(
  lease: GatewayLeaseHandle,
  profileName: string,
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  harness: "claude" | "codex" = "claude",
): Promise<{ token: string; args: readonly string[]; executable: string | undefined }> {
  const detect = detectForHarness(harness);
  const target = detect(environment);
  const response = await fetch(`${lease.baseUrl}/v1/launch-sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${lease.authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ profileName, leaseId: lease.leaseId }),
  });
  const payload = await response.json() as {
    token?: unknown;
    harness?: unknown;
    launchPolicy?: { executable?: unknown };
    error?: unknown;
  };
  if (!response.ok || typeof payload.token !== "string") {
    throwActivationFailure(payload);
  }
  if (typeof payload.harness === "string" && payload.harness !== harness) {
    throw new Error(`Profile harness is ${payload.harness}, not ${harness}`);
  }
  const configured = payload.launchPolicy?.executable;
  const resolved = detect(
    environment,
    typeof configured === "string" ? { executable: configured } : {},
  );
  return {
    token: payload.token,
    args,
    executable: resolved.found ? resolved.executable : target.executable,
  };
}

export function childExitCode(exit: ChildExit): number {
  if (exit.code !== null) return exit.code;
  if (exit.signal !== null) return 128 + osConstants.signals[exit.signal];
  return 1;
}

export type CliDependencies = Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
  launchClaude?: (options: LaunchClaudeOptions) => Promise<ChildExit>;
  launchCodex?: (options: LaunchClaudeOptions) => Promise<ChildExit>;
  acquireGateway?: (options: Parameters<typeof acquireGateway>[0]) => Promise<GatewayLeaseHandle>;
  issueProfileLaunch?: (
    lease: GatewayLeaseHandle,
    profileName: string,
    args: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    harness?: "claude" | "codex",
  ) => Promise<{ token: string; args: readonly string[]; executable: string | undefined }>;
  prepareClaudeOverlay?: (controlPlaneDirectory: string) => Promise<ClaudeOverlayResolution>;
  runInit?: (configPath: string) => Promise<number>;
  runGateway?: (action: GatewayAction, configPath: string) => Promise<number>;
}>;

async function runHarnessCommand(
  parsed: Extract<ParsedCliCommand, { command: "run-claude" | "run-codex" }>,
  dependencies: CliDependencies,
): Promise<number> {
  const config = await loadConfig(parsed.configPath);
  const harness = parsed.command === "run-codex" ? "codex" : "claude";
  const claudeArgs = parsed.route === undefined
    ? parsed.claudeArgs
    : harness === "claude"
      ? routeScopedClaudeArgs(parsed.claudeArgs, configuredRoleForRoute(config, parsed.route))
      : (configuredRoleForRoute(config, parsed.route), parsed.claudeArgs);
  // Claude launches point CLAUDE_CONFIG_DIR at the durable RLY overlay
  // (composed from native user config) instead of a throwaway temp directory.
  // Codex keeps its historical throwaway CODEX_HOME isolation. The default
  // RLY home resolves from the launch environment so tests and other callers
  // with an overridden HOME never touch the real user home.
  const configDirectory = harness === "codex"
    ? undefined
    : (await (dependencies.prepareClaudeOverlay ?? prepareClaudeOverlay)(
        config.controlPlane.dataDirectory ?? join(dependencies.environment["HOME"] ?? homedir(), RLY_STATE_DIRECTORY_NAME),
        { environment: dependencies.environment },
      )).directory;
  const lease = await (dependencies.acquireGateway ?? acquireGateway)({ config });
  try {
    const launched = parsed.profile === undefined
      ? { token: lease.authToken, args: claudeArgs, executable: undefined as string | undefined }
      : await (dependencies.issueProfileLaunch ?? issueProfileLaunch)(lease, parsed.profile, claudeArgs, dependencies.environment, harness);
    const launch = harness === "codex" ? (dependencies.launchCodex ?? launchCodex) : (dependencies.launchClaude ?? launchClaude);
    const exit = await launch({
      gatewayBaseUrl: lease.baseUrl,
      authToken: launched.token,
      args: launched.args,
      environment: dependencies.environment,
      ...(launched.executable === undefined ? {} : { executable: launched.executable }),
      ...(configDirectory === undefined ? {} : { configDirectory }),
    });
    return childExitCode(exit);
  } finally {
    await lease.release();
  }
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = { environment: process["env"] },
): Promise<number> {
  const parsed = parseCliArgs(args);
  if (parsed === undefined) {
    usage();
    return 2;
  }
  if (parsed.command === "run-claude" || parsed.command === "run-codex") return runHarnessCommand(parsed, dependencies);
  if (parsed.command === "init") return (dependencies.runInit ?? runInit)(parsed.configPath);
  if (parsed.command === "gateway") return (dependencies.runGateway ?? runGatewayCommand)(parsed.action, parsed.configPath);
  if (parsed.command === "admin") return runAdmin(parsed, await loadConfig(parsed.configPath));
  if (parsed.command === "config") return runConfig(parsed);
  if (parsed.command === "doctor") return runDoctor(parsed.configPath);
  if (parsed.command === "status") return runStatus(parsed.configPath);
  if (parsed.command === "quota") return runQuota(parsed.configPath);
  return runRouteTrace(parsed.configPath);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const code = await runCli(args);
  process.exitCode = code;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
  });
}
