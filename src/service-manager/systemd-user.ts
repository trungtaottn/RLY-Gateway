import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSystemdUserUnit } from "./definitions.js";
import {
  defaultServiceCommandRunner,
  RLY_SERVICE_NAME,
  type ServiceCommandResult,
  type ServiceCommandRunner,
  type ServiceDefinitionInput,
  type ServiceManagerAdapter,
  type ServicePlatform,
  type ServiceStatus,
} from "./types.js";

export type SystemdUserOptions = Readonly<{
  home?: string;
  serviceName?: string;
  runner?: ServiceCommandRunner;
}>;

const UNIT_MODE = 0o600;

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Linux systemd --user adapter. Registers a per-user unit under
 * ~/.config/systemd/user and manages it through `systemctl --user`.
 * Registration never requires root and is idempotent; Restart=on-failure
 * provides crash recovery.
 */
export class SystemdUserAdapter implements ServiceManagerAdapter {
  readonly platform: ServicePlatform = "linux";
  readonly serviceName: string;
  readonly #home: string;
  readonly #runner: ServiceCommandRunner;

  public constructor(options: SystemdUserOptions = {}) {
    this.serviceName = options.serviceName ?? RLY_SERVICE_NAME;
    this.#home = options.home ?? homedir();
    this.#runner = options.runner ?? defaultServiceCommandRunner;
  }

  get #unitDirectory(): string {
    return join(this.#home, ".config", "systemd", "user");
  }

  get #unitPath(): string {
    return join(this.#unitDirectory, `${this.serviceName}.service`);
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
    await mkdir(this.#unitDirectory, { recursive: true });
    const unit = buildSystemdUserUnit(input);
    await writeFile(this.#unitPath, unit, { mode: UNIT_MODE });
    await chmod(this.#unitPath, UNIT_MODE);
    await this.#systemctl("daemon-reload");
  }

  public async start(): Promise<void> {
    await this.#systemctl("enable", "--now", `${this.serviceName}.service`);
  }

  public async stop(): Promise<void> {
    await this.#systemctl("stop", `${this.serviceName}.service`);
  }

  public async status(): Promise<ServiceStatus> {
    if (!(await this.isRegistered())) return "not-registered";
    const result = await this.#systemctl("is-active", `${this.serviceName}.service`);
    const state = result.stdout.trim();
    if (result.code === 0 && state === "active") return "running";
    if (state === "inactive" || state === "failed") return "stopped";
    return "unknown";
  }

  public async unregister(): Promise<void> {
    await this.#systemctl("disable", "--now", `${this.serviceName}.service`).catch(() => undefined);
    await unlink(this.#unitPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
    await this.#systemctl("daemon-reload").catch(() => undefined);
  }

  async #systemctl(...args: readonly string[]): Promise<ServiceCommandResult> {
    const result = await this.#runner("systemctl", ["--user", ...args]);
    if (result.code !== 0) {
      throw new Error(`systemctl ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`);
    }
    return result;
  }
}
