#!/usr/bin/env node
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAdminArgs, runAdmin, type AdminCommand } from "./admin.js";
import { runDoctor, runQuota, runRouteTrace, runStatus } from "./diagnostics.js";
import { loadConfig } from "../config/load-config.js";
import { launchClaude, launchCodex, type ChildExit, type LaunchClaudeOptions } from "../runtime/child-launcher.js";
import { acquireGateway, type GatewayLeaseHandle } from "../runtime/gateway-lifecycle.js";
import { detectClaudeTarget, detectCodexTarget } from "../targets/detect.js";

const DEFAULT_CONFIG = "gateway.config.toml";
const DIAGNOSTIC_COMMANDS = ["status", "doctor", "quota", "route-trace"] as const;
const ROUTE_ROLES = ["primary", "fast", "reasoning"] as const;

function usage(): void {
  console.log("Usage: agent-gateway <status|doctor|quota|route-trace> [--config path] | admin <providers|accounts|pools|profiles|credentials|ui> ... [--config path] | run <claude|codex> [--config path] [--profile name | --route provider/model] -- [harness args]");
}

export type ParsedCliCommand =
  | Readonly<{ command: "status" | "doctor" | "quota" | "route-trace"; configPath: string }>
  | Readonly<{ command: "run-claude" | "run-codex"; configPath: string; claudeArgs: readonly string[]; route?: string; profile?: string }>
  | AdminCommand;

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

/** Parses gateway arguments and leaves all arguments after `--` untouched for Claude. */
export function parseCliArgs(args: readonly string[], cwd = process.cwd()): ParsedCliCommand | undefined {
  const [command] = args;
  if (isDiagnosticCommand(command)) {
    return { command, configPath: configPath(args.slice(1), cwd) };
  }
  if (command === "admin") {
    return parseAdminArgs(args.filter((value, index, all) => value !== "--config" && all[index - 1] !== "--config"), configPath(args, cwd));
  }
  const harness = args[1];
  if (command !== "run" || (harness !== "claude" && harness !== "codex")) return undefined;
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
  };
  if (!response.ok || typeof payload.token !== "string") {
    throw new Error("Profile activation failed");
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
  if (parsed.command === "admin") return runAdmin(parsed, await loadConfig(parsed.configPath));
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
