import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShutdownController } from "./shutdown-controller.js";

const CLAUDE_BASE_URL_VARIABLE = "ANTHROPIC_BASE_URL";
const CLAUDE_AUTH_TOKEN_VARIABLE = "ANTHROPIC_AUTH_TOKEN";
const CLAUDE_CONFIG_DIRECTORY_VARIABLE = "CLAUDE_CONFIG_DIR";
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

export type ChildExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;

export type ChildProcessLike = Readonly<{
  once: {
    (event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    (event: "error", listener: (error: Error) => void): unknown;
  };
  kill: (signal?: NodeJS.Signals) => boolean;
}>;

export type ChildSpawner = (
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd?: string; env: NodeJS.ProcessEnv; stdio: "inherit" }>,
) => ChildProcessLike;

export type SignalSource = Readonly<{
  once: (signal: NodeJS.Signals, listener: () => void) => unknown;
  removeListener: (signal: NodeJS.Signals, listener: () => void) => unknown;
}>;

export type LaunchClaudeOptions = Readonly<{
  gatewayBaseUrl: string;
  authToken: string;
  args: readonly string[];
  executable?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  cwd?: string;
  spawner?: ChildSpawner;
  signalSource?: SignalSource;
  abortSignal?: AbortSignal;
  shutdownTimeoutMs?: number;
}>;

/** Claude documents this print-mode flag; do not depend on undocumented state-directory variables. */
function sessionIsolatedArgs(args: readonly string[]): readonly string[] {
  const printMode = args.includes("-p") || args.includes("--print");
  return printMode && !args.includes("--no-session-persistence")
    ? [...args, "--no-session-persistence"]
    : args;
}

function spawnChild(
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd?: string; env: NodeJS.ProcessEnv; stdio: "inherit" }>,
): ChildProcessLike {
  return spawn(executable, args, options);
}

function waitForChildExit(child: ChildProcessLike): Promise<ChildExit> {
  return new Promise((resolve, reject) => {
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      resolve({ code, signal });
    };
    const onError = (error: Error): void => {
      reject(error);
    };
    child.once("close", onClose);
    child.once("error", onError);
  });
}

/** Creates a child-only Claude environment without mutating the parent process. */
export function createClaudeChildEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  gatewayBaseUrl: string,
  authToken: string,
  configDirectory?: string,
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    [CLAUDE_BASE_URL_VARIABLE]: gatewayBaseUrl,
    [CLAUDE_AUTH_TOKEN_VARIABLE]: authToken,
    ...(configDirectory === undefined ? {} : { [CLAUDE_CONFIG_DIRECTORY_VARIABLE]: configDirectory }),
  };
  delete childEnvironment["ANTHROPIC_API_KEY"];
  return childEnvironment;
}

function installSignalForwarding(
  source: SignalSource,
  controller: ShutdownController,
  completion: Promise<unknown>,
  setStopSignal: (signal: NodeJS.Signals) => void,
): () => void {
  const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const listeners = signals.map((signal) => ({
    signal,
    listener: (): void => {
      setStopSignal(signal);
      void controller.shutdown(completion);
    },
  }));
  for (const { signal, listener } of listeners) source.once(signal, listener);
  return (): void => {
    for (const { signal, listener } of listeners) source.removeListener(signal, listener);
  };
}

/** Runs Claude in the foreground with gateway configuration scoped solely to the child. */
export async function launchClaude(options: LaunchClaudeOptions): Promise<ChildExit> {
  const currentEnvironment = process["env"];
  const configDirectory = mkdtempSync(join(tmpdir(), "agent-gateway-claude-"));
  const environment = createClaudeChildEnvironment(
    options.environment ?? currentEnvironment,
    options.gatewayBaseUrl,
    options.authToken,
    configDirectory,
  );
  let child: ChildProcessLike;
  try {
    child = (options.spawner ?? spawnChild)(options.executable ?? "claude", sessionIsolatedArgs(options.args), {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: environment,
      stdio: "inherit",
    });
  } catch (error) {
    await rm(configDirectory, { recursive: true, force: true });
    throw error;
  }
  const exit = waitForChildExit(child);
  let stopSignal: NodeJS.Signals = "SIGTERM";
  const controller = new ShutdownController({
    timeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    requestStop: () => { child.kill(stopSignal); },
    forceStop: () => { child.kill("SIGKILL"); },
  });
  const removeSignalForwarding = installSignalForwarding(
    options.signalSource ?? process,
    controller,
    exit,
    (signal) => { stopSignal = signal; },
  );
  const cancel = (): void => { void controller.shutdown(exit); };
  options.abortSignal?.addEventListener("abort", cancel, { once: true });
  try {
    if (options.abortSignal?.aborted) cancel();
    return await exit;
  } finally {
    removeSignalForwarding();
    options.abortSignal?.removeEventListener("abort", cancel);
    await rm(configDirectory, { recursive: true, force: true });
  }
}
