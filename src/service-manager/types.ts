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
