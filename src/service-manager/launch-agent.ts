import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildLaunchAgentPlist } from "./definitions.js";
import {
  defaultServiceCommandRunner,
  RLY_LAUNCH_AGENT_LABEL,
  type ServiceCommandResult,
  type ServiceCommandRunner,
  type ServiceDefinitionInput,
  type ServiceDetail,
  type ServiceManagerAdapter,
  type ServicePlatform,
  type ServiceStatus,
} from "./types.js";

export type LaunchAgentOptions = Readonly<{
  home: string;
  label?: string;
  runner?: ServiceCommandRunner;
  logPath?: string;
  /** Stable process working directory written into the plist (path only). */
  workingDirectory?: string;
}>;

const PLIST_MODE = 0o600;
const LAUNCH_AGENTS_MODE = 0o700;

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** launchctl returns EINVAL/EALREADY when the job is already loaded. */
function isTolerableLoadError(result: ServiceCommandResult): boolean {
  return result.code === 0 || result.code === 5 || /already|EALREADY|bootstrapped/i.test(result.stderr);
}

/** bootout/unload of an already-unloaded job is not a failure. */
function isTolerableStopError(result: ServiceCommandResult): boolean {
  return result.code === 0 || /no such process|ENOENT|not found|EINVAL|invalid/i.test(result.stderr);
}

/** launchctl v2 subcommands do not exist on legacy launchd. */
function isLegacyUnsupported(result: ServiceCommandResult): boolean {
  return result.code !== 0 && /not supported|no such subcommand|unknown subcommand|invalid subcommand/i.test(result.stderr);
}

function launchctlError(action: string, result: ServiceCommandResult): Error {
  return new Error(`launchctl ${action} failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`);
}

function parsePid(output: string): number | undefined {
  const match = output.match(/(?:^|\n)\s*pid\s*=\s*(\d+)/m);
  if (!match) return undefined;
  const pid = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Legacy `launchctl list <label>` prints a `pid\tlabel\tstatus` line. */
function parseLegacyPid(line: string): number | undefined {
  const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * macOS user LaunchAgent adapter. Registers a per-user plist under
 * ~/Library/LaunchAgents and manages it through launchctl's gui domain with
 * legacy launchctl fallback. Registration never requires root and is
 * idempotent; changed/stale definitions are unloaded before reload so launchd
 * never keeps pointing at an old executable.
 */
export class LaunchAgentAdapter implements ServiceManagerAdapter {
  readonly platform: ServicePlatform = "darwin";
  readonly serviceName: string;
  readonly #home: string;
  readonly #label: string;
  readonly #runner: ServiceCommandRunner;
  readonly #logPath: string | undefined;
  readonly #workingDirectory: string | undefined;

  public constructor(options: LaunchAgentOptions) {
    this.serviceName = options.label ?? RLY_LAUNCH_AGENT_LABEL;
    this.#home = options.home;
    this.#label = options.label ?? RLY_LAUNCH_AGENT_LABEL;
    this.#runner = options.runner ?? defaultServiceCommandRunner;
    this.#logPath = options.logPath;
    this.#workingDirectory = options.workingDirectory;
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

  /** Per-user services must never be registered or managed as root. */
  #assertNotRoot(): void {
    const uid = process.getuid?.();
    if (uid === 0) {
      throw new Error("RLY per-user service registration must not run as root; run rly init without sudo");
    }
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
    this.#assertNotRoot();
    await mkdir(this.#launchAgentsDirectory, { recursive: true, mode: LAUNCH_AGENTS_MODE });
    await chmod(this.#launchAgentsDirectory, LAUNCH_AGENTS_MODE).catch(() => undefined);
    const logPath = input.logPath ?? this.#logPath;
    if (logPath !== undefined) {
      await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    }
    const plist = buildLaunchAgentPlist({
      ...input,
      label: this.#label,
      ...(logPath === undefined ? {} : { logPath }),
      ...(this.#workingDirectory === undefined ? {} : { workingDirectory: this.#workingDirectory }),
    });
    const previous = await readFile(this.#plistPath, "utf8").catch(() => undefined);
    await this.#writePlistAtomically(plist);
    // A prior definition whose content changed must be unloaded before the new
    // one is bootstrapped, otherwise launchd keeps the stale executable/paths.
    if (previous !== undefined && previous !== plist) {
      const unloaded = await this.#bootout();
      if (unloaded.code !== 0 && !isTolerableStopError(unloaded)) {
        throw launchctlError("bootout", unloaded);
      }
    }
    await this.#bootstrap();
  }

  public async start(): Promise<void> {
    this.#assertNotRoot();
    await this.#kickstart(false);
  }

  /**
   * Process-level restart (`kickstart -k`). Callers that need a controlled
   * restart must drain launch sessions first through the authenticated runtime
   * shutdown path; this adapter never signals an unknown port owner.
   */
  public async restart(): Promise<void> {
    this.#assertNotRoot();
    await this.#kickstart(true);
  }

  public async stop(): Promise<void> {
    this.#assertNotRoot();
    const result = await this.#bootout();
    if (result.code !== 0 && !isTolerableStopError(result)) {
      throw launchctlError("bootout", result);
    }
  }

  public async status(): Promise<ServiceStatus> {
    if (!(await this.isRegistered())) return "not-registered";
    return (await this.detail()).running ? "running" : "stopped";
  }

  /**
   * macOS-specific detail: registration/load state and the live pid, reported
   * separately from runtime `/identity` readiness. Not part of the shared
   * adapter contract; callers use `serviceDetail()` duck-typing.
   */
  public async detail(): Promise<ServiceDetail> {
    const base = {
      label: this.#label,
      definitionPath: this.#plistPath,
      registered: false,
      loaded: false,
      running: false,
    };
    if (!(await this.isRegistered())) return base;
    const result = await this.#runner("/bin/launchctl", ["print", this.#domainTarget, this.#label]);
    if (result.code === 0) {
      const running = /(?:^|\n)\s*state\s*=\s*running\b/m.test(result.stdout);
      const pid = parsePid(result.stdout);
      return {
        ...base,
        registered: true,
        loaded: true,
        running,
        ...(pid === undefined ? {} : { pid }),
      };
    }
    if (isLegacyUnsupported(result)) {
      const legacy = await this.#runner("/bin/launchctl", ["list", this.#label]);
      if (legacy.code !== 0) return base;
      const line = legacy.stdout.split("\n").find((candidate) => candidate.includes(this.#label));
      const pid = line === undefined ? undefined : parseLegacyPid(line);
      return {
        ...base,
        registered: true,
        loaded: true,
        running: pid !== undefined,
        ...(pid === undefined ? {} : { pid }),
      };
    }
    return { ...base, registered: true };
  }

  public async unregister(): Promise<void> {
    await this.stop().catch(() => undefined);
    await unlink(this.#plistPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }

  async #writePlistAtomically(plist: string): Promise<void> {
    const temporaryPath = join(this.#launchAgentsDirectory, `.${this.#label}.${randomUUID()}.plist.tmp`);
    try {
      await writeFile(temporaryPath, plist, { mode: PLIST_MODE });
      await chmod(temporaryPath, PLIST_MODE);
      await rename(temporaryPath, this.#plistPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async #bootstrap(): Promise<void> {
    const result = await this.#runner("/bin/launchctl", ["bootstrap", this.#domainTarget, this.#plistPath]);
    if (result.code === 0 || isTolerableLoadError(result)) return;
    if (isLegacyUnsupported(result)) {
      const legacy = await this.#runner("/bin/launchctl", ["load", "-w", this.#plistPath]);
      if (legacy.code !== 0 && !isTolerableLoadError(legacy)) throw launchctlError("load", legacy);
      return;
    }
    throw launchctlError("bootstrap", result);
  }

  async #kickstart(killFirst: boolean): Promise<void> {
    const args = killFirst
      ? ["kickstart", "-k", this.#domainTarget, this.#label]
      : ["kickstart", this.#domainTarget, this.#label];
    const result = await this.#runner("/bin/launchctl", args);
    if (result.code === 0 || isTolerableLoadError(result)) return;
    if (isLegacyUnsupported(result)) {
      const action = killFirst ? "stop" : "start";
      const legacy = await this.#runner("/bin/launchctl", [action, this.#label]);
      if (legacy.code !== 0) throw launchctlError(action, legacy);
      return;
    }
    throw launchctlError("kickstart", result);
  }

  async #bootout(): Promise<ServiceCommandResult> {
    const result = await this.#runner("/bin/launchctl", ["bootout", this.#domainTarget, this.#label]);
    if (result.code !== 0 && !isTolerableStopError(result) && isLegacyUnsupported(result)) {
      return this.#runner("/bin/launchctl", ["unload", this.#plistPath]);
    }
    return result;
  }
}
