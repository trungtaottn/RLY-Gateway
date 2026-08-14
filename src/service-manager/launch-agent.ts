import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildLaunchAgentPlist } from "./definitions.js";
import {
  defaultServiceCommandRunner,
  RLY_LAUNCH_AGENT_LABEL,
  type ServiceCommandResult,
  type ServiceCommandRunner,
  type ServiceDefinitionInput,
  type ServiceManagerAdapter,
  type ServicePlatform,
  type ServiceStatus,
} from "./types.js";

export type LaunchAgentOptions = Readonly<{
  home: string;
  label?: string;
  runner?: ServiceCommandRunner;
  logPath?: string;
}>;

const PLIST_MODE = 0o600;

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** launchctl returns EINVAL/EALREADY when the job is already loaded. */
function isTolerableLoadError(result: ServiceCommandResult): boolean {
  return result.code === 0 || result.code === 5 || /already|EALREADY|bootstrapped/i.test(result.stderr);
}

/**
 * macOS user LaunchAgent adapter. Registers a per-user plist under
 * ~/Library/LaunchAgents and manages it through launchctl's gui domain.
 * Registration never requires root and is idempotent.
 */
export class LaunchAgentAdapter implements ServiceManagerAdapter {
  readonly platform: ServicePlatform = "darwin";
  readonly serviceName: string;
  readonly #home: string;
  readonly #label: string;
  readonly #runner: ServiceCommandRunner;
  readonly #logPath: string | undefined;

  public constructor(options: LaunchAgentOptions) {
    this.serviceName = options.label ?? RLY_LAUNCH_AGENT_LABEL;
    this.#home = options.home;
    this.#label = options.label ?? RLY_LAUNCH_AGENT_LABEL;
    this.#runner = options.runner ?? defaultServiceCommandRunner;
    this.#logPath = options.logPath;
  }

  get #launchAgentsDirectory(): string {
    return join(this.#home, "Library", "LaunchAgents");
  }

  get #plistPath(): string {
    return join(this.#launchAgentsDirectory, `${this.#label}.plist`);
  }

  get #domainTarget(): string {
    return `gui/${String(process.getuid?.() ?? 0)}`;
  }

  public isSupported(): boolean {
    return true;
  }

  public async isRegistered(): Promise<boolean> {
    try {
      await readFile(this.#plistPath);
      return true;
    } catch {
      return false;
    }
  }

  public async register(input: ServiceDefinitionInput): Promise<void> {
    await mkdir(this.#launchAgentsDirectory, { recursive: true });
    const definition = this.#logPath === undefined || input.logPath !== undefined
      ? input
      : { ...input, logPath: this.#logPath };
    const plist = buildLaunchAgentPlist({ ...definition, label: this.#label });
    await writeFile(this.#plistPath, plist, { mode: PLIST_MODE });
    await chmod(this.#plistPath, PLIST_MODE);
    const result = await this.#runner("/bin/launchctl", ["bootstrap", this.#domainTarget, this.#plistPath]);
    if (!isTolerableLoadError(result)) {
      throw new Error(`launchctl bootstrap failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`);
    }
  }

  public async start(): Promise<void> {
    const result = await this.#runner("/bin/launchctl", ["kickstart", this.#domainTarget, this.#label]);
    if (result.code !== 0 && !isTolerableLoadError(result)) {
      throw new Error(`launchctl kickstart failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`);
    }
  }

  public async stop(): Promise<void> {
    const result = await this.#runner("/bin/launchctl", ["bootout", this.#domainTarget, this.#label]);
    if (result.code !== 0 && !/no such process|ENOENT|not found/i.test(result.stderr)) {
      throw new Error(`launchctl bootout failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`);
    }
  }

  public async status(): Promise<ServiceStatus> {
    if (!(await this.isRegistered())) return "not-registered";
    const result = await this.#runner("/bin/launchctl", ["print", this.#domainTarget, this.#label]);
    return result.code === 0 ? "running" : "stopped";
  }

  public async unregister(): Promise<void> {
    await this.stop().catch(() => undefined);
    await unlink(this.#plistPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}
