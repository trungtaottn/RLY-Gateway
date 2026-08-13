#!/usr/bin/env node
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/load-config.js";
import { launchClaude, type ChildExit, type LaunchClaudeOptions } from "../runtime/child-launcher.js";
import { acquireGateway, inspectGateway, type GatewayLeaseHandle } from "../runtime/gateway-lifecycle.js";

const DEFAULT_CONFIG = "gateway.config.toml";
function usage(): void {
  console.log("Usage: agent-gateway <status|doctor> [--config path] | run claude [--config path] [--route provider/model] -- [claude args]");
}

export type ParsedCliCommand =
  | Readonly<{ command: "status" | "doctor"; configPath: string }>
  | Readonly<{ command: "run-claude"; configPath: string; claudeArgs: readonly string[]; route?: string }>;

function configPath(args: readonly string[], cwd: string): string {
  const index = args.indexOf("--config");
  const configuredPath = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && configuredPath === undefined) throw new Error("--config requires a path");
  return resolve(cwd, configuredPath ?? DEFAULT_CONFIG);
}

/** Parses gateway arguments and leaves all arguments after `--` untouched for Claude. */
export function parseCliArgs(args: readonly string[], cwd = process.cwd()): ParsedCliCommand | undefined {
  const [command] = args;
  if (command === "status" || command === "doctor") {
    return { command, configPath: configPath(args.slice(1), cwd) };
  }
  if (command !== "run" || args[1] !== "claude") return undefined;
  const separator = args.indexOf("--", 2);
  if (separator < 0) throw new Error("run claude requires `--` before Claude arguments");
  const options = args.slice(2, separator);
  const routeIndex = options.indexOf("--route");
  const route = routeIndex < 0 ? undefined : options[routeIndex + 1];
  if (routeIndex >= 0 && (route === undefined || route.startsWith("--"))) throw new Error("--route requires an exact provider/model value");
  if (routeIndex >= 0 && options.filter((value) => value === "--route").length !== 1) throw new Error("--route may be provided once");
  return {
    command: "run-claude",
    configPath: configPath(options, cwd),
    claudeArgs: args.slice(separator + 1),
    ...(route === undefined ? {} : { route }),
  };
}

function configuredRoleForRoute(config: Awaited<ReturnType<typeof loadConfig>>, route: string): "primary" | "fast" | "reasoning" {
  const match = (Object.entries(config.routes) as ["primary" | "fast" | "reasoning", typeof config.routes.primary][])
    .find(([, candidate]) => candidate !== undefined && `${candidate.provider}/${candidate.model}` === route);
  if (!match) throw new Error("Requested route is not configured");
  return match[0];
}

function routeScopedClaudeArgs(args: readonly string[], role: "primary" | "fast" | "reasoning"): readonly string[] {
  if (args.includes("--model")) throw new Error("--model cannot be combined with gateway --route");
  return ["--model", role, ...args];
}

async function canRead(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isPlaceholderModel(model: string): boolean {
  return model.startsWith("replace-with-");
}

async function doctor(path: string): Promise<number> {
  if (!(await canRead(path))) {
    console.log(JSON.stringify({ ok: false, config: "missing", path }));
    return 1;
  }
  try {
    const config = await loadConfig(path);
    const placeholderRoutes = Object.entries(config.routes)
      .filter(([, route]) => route !== undefined && isPlaceholderModel(route.model))
      .map(([role]) => role);
    console.log(JSON.stringify({
      ok: true,
      syntaxValid: true,
      operationalReady: placeholderRoutes.length === 0,
      schemaVersion: config.schemaVersion,
      host: config.gateway.host,
      port: config.gateway.port,
      routes: Object.keys(config.routes).length,
      placeholderRoutes,
    }));
    return 0;
  } catch {
    console.log(JSON.stringify({
      ok: false,
      config: "invalid",
      error: "Configuration validation failed; inspect the file locally",
    }));
    return 1;
  }
}

async function status(path: string): Promise<number> {
  if (!(await canRead(path))) {
    console.log(JSON.stringify({ configured: false, running: false }));
    return 1;
  }
  const config = await loadConfig(path);
  const state = await inspectGateway(config);
  const running = state === "attested-compatible";
  console.log(JSON.stringify({
    configured: true,
    running,
    state,
    host: config.gateway.host,
    port: config.gateway.port,
  }));
  return running ? 0 : 1;
}

export function childExitCode(exit: ChildExit): number {
  if (exit.code !== null) return exit.code;
  if (exit.signal !== null) return 128 + osConstants.signals[exit.signal];
  return 1;
}

export type CliDependencies = Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
  launchClaude?: (options: LaunchClaudeOptions) => Promise<ChildExit>;
  acquireGateway?: (options: Parameters<typeof acquireGateway>[0]) => Promise<GatewayLeaseHandle>;
}>;

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = { environment: process["env"] },
): Promise<number> {
  const parsed = parseCliArgs(args);
  if (parsed === undefined) {
    usage();
    return 2;
  }
  const path = parsed.configPath;
  let code: number;
  if (parsed.command === "doctor") code = await doctor(path);
  else if (parsed.command === "status") code = await status(path);
  else {
    if (!("claudeArgs" in parsed)) throw new Error("Invalid Claude command");
    const config = await loadConfig(path);
    const claudeArgs = parsed.route === undefined
      ? parsed.claudeArgs
      : routeScopedClaudeArgs(parsed.claudeArgs, configuredRoleForRoute(config, parsed.route));
    const lease = await (dependencies.acquireGateway ?? acquireGateway)({ config });
    try {
      const exit = await (dependencies.launchClaude ?? launchClaude)({
        gatewayBaseUrl: lease.baseUrl,
        authToken: lease.authToken,
        args: claudeArgs,
        environment: dependencies.environment,
      });
      code = childExitCode(exit);
    } finally {
      await lease.release();
    }
  }
  return code;
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
