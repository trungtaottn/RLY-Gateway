import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { buildSystemdUserUnit } from "./definitions.js";
import {
  defaultServiceCommandRunner,
  RLY_SERVICE_NAME,
  type ServiceCommandResult,
  type ServiceCommandRunner,
  type ServiceDefinitionInput,
  type ServiceDetail,
  type ServiceManagerAdapter,
  type ServicePlatform,
  type ServiceStatus,
} from "./types.js";

export type SystemdUserOptions = Readonly<{
  home?: string;
  serviceName?: string;
  runner?: ServiceCommandRunner;
  logPath?: string;
  /** Stable process working directory written into the unit (path only). */
  workingDirectory?: string;
}>;

const UNIT_MODE = 0o600;
const UNIT_DIRECTORY_MODE = 0o700;

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** `systemctl --user` fails this way when no per-user systemd manager bus exists. */
function isNoUserManager(result: ServiceCommandResult): boolean {
  return /Failed to connect to bus|System has not been booted with systemd|Cannot open bus|Connection refused/i.test(result.stderr);
}

/** `systemctl stop` of an already-stopped/unknown unit is not a failure. */
function isTolerableStopError(result: ServiceCommandResult): boolean {
  return result.code === 0 || /Unit .* not loaded|No such unit|is not loaded|not found/i.test(result.stderr);
}

/**
 * Builds an actionable error. When no user manager is reachable the message
 * names the cause (containers/minimal distros/WSL) and states the deliberate
 * no-linger policy instead of silently pretending registration succeeded.
 */
function systemctlError(action: string, result: ServiceCommandResult): Error {
  if (isNoUserManager(result)) {
    return new Error(
      `RLY cannot ${action}: no reachable systemd user manager (${result.stderr.trim() || `exit ${String(result.code)}`}). `
      + "This usually means the session has no user D-Bus, common in containers, minimal distros, or WSL without systemd. "
      + "RLY deliberately does not enable `loginctl enable-linger` because it changes OS account behavior beyond the "
      + "login lifetime; run `rly init` from a logged-in terminal session on a systemd host.",
    );
  }
  return new Error(`RLY cannot ${action}: ${result.stderr.trim() || `exit ${String(result.code)}`}`);
}

/**
 * Linux systemd --user adapter. Registers a per-user unit under
 * ~/.config/systemd/user and manages it through `systemctl --user`.
 * Registration never requires root and is idempotent; the unit uses a bounded
 * Restart=on-failure policy so repeated broken startups become a diagnosable
 * `failed` state instead of an uncontrolled tight loop. `systemctl --user`
 * requires a reachable user manager bus; when none exists the adapter fails
 * actionably rather than pretending registration succeeded.
 */
export class SystemdUserAdapter implements ServiceManagerAdapter {
  readonly platform: ServicePlatform = "linux";
  readonly serviceName: string;
  readonly #home: string;
  readonly #runner: ServiceCommandRunner;
  readonly #logPath: string | undefined;
  readonly #workingDirectory: string | undefined;

  public constructor(options: SystemdUserOptions = {}) {
    this.serviceName = options.serviceName ?? RLY_SERVICE_NAME;
    this.#home = options.home ?? homedir();
    this.#runner = options.runner ?? defaultServiceCommandRunner;
    this.#logPath = options.logPath;
    this.#workingDirectory = options.workingDirectory;
  }

  get #unitDirectory(): string {
    return join(this.#home, ".config", "systemd", "user");
  }

  get #unitPath(): string {
    return join(this.#unitDirectory, `${this.serviceName}.service`);
  }

  /** Stable on-disk definition path, exposed for reconciliation diagnostics. */
  public get definitionPath(): string {
    return this.#unitPath;
  }

  get #unitName(): string {
    return `${this.serviceName}.service`;
  }

  /** Per-user services must never be registered or managed as root. */
  #assertNotRoot(): void {
    const uid = process.getuid?.();
    if (uid === 0) {
      throw new Error("RLY per-user service registration must not run as root; run rly init without sudo");
    }
  }

  /**
   * Probes for a reachable user systemd manager before any mutating operation
   * so a session without a user D-Bus fails before touching the filesystem.
   */
  async #assertUserManagerAvailable(action: string): Promise<void> {
    const probe = await this.#runner("systemctl", ["--user", "show-environment"]);
    if (probe.code !== 0) throw systemctlError(action, probe);
  }

  public isSupported(): boolean {
    return true;
  }

  public async isRegistered(): Promise<boolean> {
    try {
      await readFile(this.#unitPath);
      return true;
    } catch {
      return false;
    }
  }

  public async register(input: ServiceDefinitionInput): Promise<void> {
    this.#assertNotRoot();
    await this.#assertUserManagerAvailable("register the per-user service");
    await mkdir(this.#unitDirectory, { recursive: true, mode: UNIT_DIRECTORY_MODE });
    await chmod(this.#unitDirectory, UNIT_DIRECTORY_MODE).catch(() => undefined);
    const logPath = input.logPath ?? this.#logPath;
    if (logPath !== undefined) {
      await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    }
    const unit = this.renderDefinition(input);
    const previous = await readFile(this.#unitPath, "utf8").catch(() => undefined);
    // daemon-reload only when the definition actually changed; an unchanged
    // re-init (repair/validation) stays a filesystem no-op and never creates a
    // duplicate unit or reloads the manager unnecessarily.
    if (previous !== unit) {
      await this.#writeUnitAtomically(unit);
      await this.#systemctl("register the per-user service", "daemon-reload");
    }
  }

  /**
   * Renders the exact unit this adapter would write for `input` (same options
   * as `register`). Used by service-definition reconciliation to detect
   * missing/stale/path-drifted definitions idempotently without touching
   * systemd.
   */
  public renderDefinition(input: ServiceDefinitionInput): string {
    const logPath = input.logPath ?? this.#logPath;
    return buildSystemdUserUnit({
      ...input,
      ...(logPath === undefined ? {} : { logPath }),
      ...(this.#workingDirectory === undefined ? {} : { workingDirectory: this.#workingDirectory }),
    });
  }

  public async start(): Promise<void> {
    this.#assertNotRoot();
    await this.#assertUserManagerAvailable("start the per-user service");
    await this.#systemctl("start the per-user service", "enable", "--now", this.#unitName);
  }

  /**
   * Process-level restart (`systemctl restart`). Callers that need a controlled
   * restart must drain launch sessions first through the authenticated runtime
   * shutdown path; this adapter never signals an unknown port owner.
   */
  public async restart(): Promise<void> {
    this.#assertNotRoot();
    await this.#assertUserManagerAvailable("restart the per-user service");
    await this.#systemctl("restart the per-user service", "restart", this.#unitName);
  }

  public async stop(): Promise<void> {
    this.#assertNotRoot();
    const result = await this.#runner("systemctl", ["--user", "stop", this.#unitName]);
    if (result.code !== 0 && !isTolerableStopError(result)) {
      throw systemctlError("stop the per-user service", result);
    }
  }

  public async status(): Promise<ServiceStatus> {
    if (!(await this.isRegistered())) return "not-registered";
    const detail = await this.detail();
    if (detail.loaded && detail.running) return "running";
    if (detail.loaded) return "stopped";
    // The unit file exists but the manager could not confirm load state.
    return "unknown";
  }

  /**
   * Linux-specific detail: registration/load state, enabled state, the raw
   * manager active state, and the live pid, reported separately from runtime
   * `/identity` readiness. Not part of the shared adapter contract; callers use
   * `serviceDetail()` duck-typing.
   */
  public async detail(): Promise<ServiceDetail> {
    const base = {
      label: this.serviceName,
      definitionPath: this.#unitPath,
      registered: false,
      loaded: false,
      running: false,
    };
    if (!(await this.isRegistered())) return base;
    const result = await this.#runner("systemctl", [
      "--user",
      "show",
      this.#unitName,
      "--property=ActiveState,SubState,MainPID,UnitFileState",
      "--value",
    ]);
    if (result.code !== 0 || result.stdout.trim() === "") {
      // Either no user manager (cannot verify) or the unit is not yet known to
      // the manager. The registration file exists, but load state is
      // unconfirmed and never reported as loaded.
      return { ...base, registered: true };
    }
    const [activeState = "", , mainPid = "", unitFileState = ""] = result.stdout.split("\n");
    const active = activeState.trim();
    const pid = Number.parseInt(mainPid.trim(), 10);
    return {
      ...base,
      registered: true,
      loaded: true,
      running: active === "active",
      ...(unitFileState.trim() === "enabled" ? { enabled: true } : { enabled: false }),
      activeState: active,
      ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    };
  }

  public async unregister(): Promise<void> {
    this.#assertNotRoot();
    // Tolerate an unreachable user manager: the durable removal below is the
    // idempotent part and never touches ~/.rly data.
    await this.#runner("systemctl", ["--user", "disable", "--now", this.#unitName]).catch(() => undefined);
    await unlink(this.#unitPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
    await this.#runner("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  }

  async #writeUnitAtomically(unit: string): Promise<void> {
    const temporaryPath = join(this.#unitDirectory, `.${this.serviceName}.${randomUUID()}.service.tmp`);
    try {
      await writeFile(temporaryPath, unit, { mode: UNIT_MODE });
      await chmod(temporaryPath, UNIT_MODE);
      await rename(temporaryPath, this.#unitPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async #systemctl(action: string, ...args: readonly string[]): Promise<ServiceCommandResult> {
    const result = await this.#runner("systemctl", ["--user", ...args]);
    if (result.code !== 0) throw systemctlError(action, result);
    return result;
  }
}
