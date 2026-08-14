import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneStore } from "../control-plane/store.js";
import { loadConfig } from "../config/load-config.js";
import type { GatewayConfig } from "../config/schema.js";
import { RUNTIME_VERSION } from "../runtime/gateway-attestation.js";
import { inspectRuntimeGateway, type RuntimeInspection } from "../runtime/gateway-lifecycle.js";
import { createServiceManager } from "../service-manager/index.js";
import type { ServiceManagerAdapter, ServiceDefinitionInput } from "../service-manager/types.js";
import { readInstallation, writeInstallation } from "../storage/installation.js";
import { resolveDefaultControlPlaneDirectory } from "../storage/paths.js";

export type InitDependencies = Readonly<{
  loadConfig?: typeof loadConfig;
  createServiceManager?: (input: Parameters<typeof createServiceManager>[0]) => ServiceManagerAdapter;
  openControlPlane?: (directory: string) => Promise<unknown>;
  waitForReadiness?: (config: GatewayConfig, directory?: string) => Promise<RuntimeInspection>;
  home?: string;
  executable?: string;
  entrypoint?: string;
}>;

const READINESS_POLL_MS = 250;
const READINESS_TIMEOUT_MS = 15_000;

async function defaultOpenControlPlane(directory: string): Promise<unknown> {
  await ControlPlaneStore.open(directory);
  return undefined;
}

async function defaultWaitForReadiness(config: GatewayConfig, directory?: string): Promise<RuntimeInspection> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  for (;;) {
    const state = await inspectRuntimeGateway(config, directory);
    if (state.state === "attested-compatible" && state.resident) return state;
    if (state.state === "occupied-foreign") return state;
    if (Date.now() >= deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_MS));
  }
}

/**
 * `rly init` bootstraps the per-user installation: it settles the durable
 * ~/.rly home, validates the control-plane store, registers the per-user
 * service idempotently, starts it, and waits for the resident runtime to come
 * up attested and compatible. Running it again repairs/validates rather than
 * creating duplicate services.
 */
export async function runInit(configPath: string, dependencies: InitDependencies = {}): Promise<number> {
  const home = dependencies.home ?? homedir();
  const config = await (dependencies.loadConfig ?? loadConfig)(configPath);
  const resolution = await resolveDefaultControlPlaneDirectory(home);
  const controlPlaneDirectory = config.controlPlane.dataDirectory ?? resolution.directory;
  try {
    await (dependencies.openControlPlane ?? defaultOpenControlPlane)(controlPlaneDirectory);
    await resolution.commit();
  } catch (error) {
    await resolution.rollback();
    throw error;
  }

  const executable = dependencies.executable ?? process.execPath;
  const entrypoint = dependencies.entrypoint ?? fileURLToPath(import.meta.url);
  const manager = (dependencies.createServiceManager ?? createServiceManager)({
    home,
  });
  const absoluteConfigPath = resolve(configPath);
  const record = {
    schemaVersion: 1 as const,
    version: RUNTIME_VERSION,
    configPath: absoluteConfigPath,
    platform: manager.isSupported() ? manager.platform : "unsupported",
    serviceName: manager.serviceName,
    registeredAt: new Date().toISOString(),
  };

  if (!manager.isSupported()) {
    await writeInstallation(controlPlaneDirectory, record);
    console.log(JSON.stringify({
      ok: true,
      initialized: true,
      service: { registered: false, platform: manager.platform },
      message: `per-user service registration is not supported on platform ${manager.platform}; the durable home is ready`,
    }));
    return 0;
  }

  const definition: ServiceDefinitionInput = {
    serviceName: manager.serviceName,
    executable,
    entrypoint,
    configPath: absoluteConfigPath,
  };
  await manager.register(definition);
  await manager.start();
  await writeInstallation(controlPlaneDirectory, record);

  const state = await (dependencies.waitForReadiness ?? defaultWaitForReadiness)(config);
  if (state.state !== "attested-compatible") {
    console.log(JSON.stringify({
      ok: false,
      initialized: false,
      service: { registered: true, platform: manager.platform, serviceName: manager.serviceName },
      runtime: { state: state.state },
      error: "resident runtime did not become ready; inspect `rly gateway status` and the service log",
    }));
    return 1;
  }
  const existing = await readInstallation(controlPlaneDirectory);
  console.log(JSON.stringify({
    ok: true,
    initialized: true,
    service: { registered: true, platform: manager.platform, serviceName: manager.serviceName },
    runtime: {
      state: state.state,
      resident: true,
      instanceId: state.instanceId,
      runtimeVersion: state.runtimeVersion ?? RUNTIME_VERSION,
    },
    home: controlPlaneDirectory,
    reinitialized: existing !== undefined,
  }));
  return 0;
}
