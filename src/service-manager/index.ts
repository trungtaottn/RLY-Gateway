import { homedir } from "node:os";
import { LaunchAgentAdapter } from "./launch-agent.js";
import { SystemdUserAdapter } from "./systemd-user.js";
import {
  RLY_LAUNCH_AGENT_LABEL,
  RLY_SERVICE_NAME,
  type ServiceCommandRunner,
  type ServiceManagerAdapter,
  type ServicePlatform,
  type ServiceStatus,
} from "./types.js";

export type CreateServiceManagerOptions = Readonly<{
  platform?: NodeJS.Platform;
  home?: string;
  runner?: ServiceCommandRunner;
  logPath?: string;
  workingDirectory?: string;
  serviceName?: string;
  label?: string;
}>;

export function createServiceManager(options: CreateServiceManagerOptions = {}): ServiceManagerAdapter {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return new LaunchAgentAdapter({
      home: options.home ?? homedir(),
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      ...(options.logPath === undefined ? {} : { logPath: options.logPath }),
      ...(options.workingDirectory === undefined ? {} : { workingDirectory: options.workingDirectory }),
    });
  }
  if (platform === "linux") {
    return new SystemdUserAdapter({
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.serviceName === undefined ? {} : { serviceName: options.serviceName }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    });
  }
  return new UnsupportedPlatformAdapter(platform);
}

/** Actionable no-op for platforms without a per-user service manager. */
class UnsupportedPlatformAdapter implements ServiceManagerAdapter {
  readonly serviceName = RLY_SERVICE_NAME;
  readonly platform: ServicePlatform = "unsupported";
  readonly #platform: string;

  public constructor(platform: NodeJS.Platform) {
    this.#platform = platform;
  }

  public isSupported(): boolean {
    return false;
  }

  public isRegistered(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public register(): Promise<void> {
    return Promise.reject(new Error(`per-user service registration is not supported on platform ${this.#platform}`));
  }

  public unregister(): Promise<void> {
    return Promise.resolve(undefined);
  }

  public start(): Promise<void> {
    return Promise.reject(new Error(`per-user service registration is not supported on platform ${this.#platform}`));
  }

  public stop(): Promise<void> {
    return Promise.reject(new Error(`per-user service registration is not supported on platform ${this.#platform}`));
  }

  public status(): Promise<ServiceStatus> {
    return Promise.resolve("not-registered");
  }
}

export { RLY_LAUNCH_AGENT_LABEL, RLY_SERVICE_NAME };
