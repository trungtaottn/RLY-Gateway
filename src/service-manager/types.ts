import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const RLY_SERVICE_NAME = "rly-gateway";
export const RLY_LAUNCH_AGENT_LABEL = "com.rly.gateway";

export type ServicePlatform = "darwin" | "linux" | "unsupported";

/**
 * Everything needed to generate a per-user service definition. Only absolute
 * paths and metadata; never credentials, account identity, or environment
 * values that could leak secrets into service-manager files or logs.
 */
export type ServiceDefinitionInput = Readonly<{
  serviceName: string;
  executable: string;
  entrypoint: string;
  configPath: string;
  logPath?: string;
}>;

export type ServiceStatus = "running" | "stopped" | "not-registered" | "unknown";

/**
 * Platform-specific detailed service state, reported separately from runtime
 * readiness. Implemented by the macOS (`detail()`) and Linux (`detail()`)
 * adapters; the shared adapter contract deliberately does not grow this member.
 */
export type ServiceDetail = Readonly<{
  label: string;
  definitionPath: string;
  registered: boolean;
  /** The service definition is currently loaded into the per-user session. */
  loaded: boolean;
  /** The loaded service currently has a running process. */
  running: boolean;
  /** Process identifier of the running service instance, when known. */
  pid?: number;
  /** The service is enabled in the per-user manager (systemd UnitFileState). */
  enabled?: boolean;
  /** Raw manager active state (systemd ActiveState: active/inactive/failed). */
  activeState?: string;
}>;

export type ServiceCommandResult = Readonly<{ code: number; stdout: string; stderr: string }>;

export type ServiceCommandRunner = (
  file: string,
  args: readonly string[],
  options?: Readonly<{ env?: NodeJS.ProcessEnv }>,
) => Promise<ServiceCommandResult>;

export interface ServiceManagerAdapter {
  readonly platform: ServicePlatform;
  readonly serviceName: string;
  isSupported(): boolean;
  isRegistered(): Promise<boolean>;
  /** Idempotent: writes/repairs the definition and (re)loads it. */
  register(input: ServiceDefinitionInput): Promise<void>;
  unregister(): Promise<void>;
  /** Idempotent start for the registered per-user service. */
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<ServiceStatus>;
}

/**
 * Returns the platform-specific service detail when the adapter provides it
 * (macOS LaunchAgent, Linux systemd --user). Never part of the required
 * contract: other adapters return undefined and CLI callers simply omit the
 * detail fields.
 */
export async function serviceDetail(manager: ServiceManagerAdapter): Promise<ServiceDetail | undefined> {
  const candidate = manager as ServiceManagerAdapter & { detail?: () => Promise<ServiceDetail> };
  return typeof candidate.detail === "function" ? candidate.detail() : undefined;
}

export async function defaultServiceCommandRunner(
  file: string,
  args: readonly string[],
  options?: Readonly<{ env?: NodeJS.ProcessEnv }>,
): Promise<ServiceCommandResult> {
  const execFileAsync = promisify(execFile);
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args], {
      env: options?.env ?? process.env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      code: typeof cause.code === "number" ? cause.code : 1,
      stdout: cause.stdout ?? "",
      stderr: cause.stderr ?? cause.message,
    };
  }
}
