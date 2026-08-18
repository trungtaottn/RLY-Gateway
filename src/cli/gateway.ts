import { homedir } from "node:os";
import { loadConfig } from "../config/load-config.js";
import { inspectRuntimeGateway } from "../runtime/gateway-lifecycle.js";
import {
  startResidentRuntime,
  stopResidentRuntime,
  type ResidentRuntimeHandle,
} from "../runtime/resident-runtime.js";
import { createServiceManager } from "../service-manager/index.js";
import { serviceDetail } from "../service-manager/types.js";
import { readInstallation } from "../storage/installation.js";
import { defaultControlPlaneDirectory } from "../storage/paths.js";

export type GatewayAction = "start" | "stop" | "status";

export type GatewayCommandDependencies = Readonly<{
  loadConfig?: typeof loadConfig;
  startResidentRuntime?: (options: Parameters<typeof startResidentRuntime>[0]) => Promise<ResidentRuntimeHandle>;
  stopResidentRuntime?: (config: Parameters<typeof stopResidentRuntime>[0]) => Promise<{ state: "stopped" | "not-running" }>;
  createServiceManager?: (input: Parameters<typeof createServiceManager>[0]) => ReturnType<typeof createServiceManager>;
}>;

export async function runGatewayCommand(
  action: GatewayAction,
  configPath: string,
  dependencies: GatewayCommandDependencies = {},
): Promise<number> {
  const config = await (dependencies.loadConfig ?? loadConfig)(configPath);
  if (action === "status") {
    const state = await inspectRuntimeGateway(config);
    const installation = await readInstallation(config.controlPlane.dataDirectory ?? defaultControlPlaneDirectory());
    const servingBuild = state.state === "attested-compatible" ? state.buildIdentity : undefined;
    // Report service registration/load state separately from runtime readiness
    // on platforms with a per-user service manager (macOS LaunchAgent, Linux
    // systemd --user). Only consulted when an installation record exists, so
    // status never runs launchctl/systemctl against a fresh home.
    const detail = installation !== undefined && (installation.platform === "darwin" || installation.platform === "linux")
      ? await serviceDetail((dependencies.createServiceManager ?? createServiceManager)({ home: homedir() }))
      : undefined;
    console.log(JSON.stringify({
      running: state.state === "attested-compatible",
      state: state.state,
      ...(state.state === "attested-compatible"
        ? { resident: state.resident, runtimeVersion: state.runtimeVersion, instanceId: state.instanceId }
        : {}),
      // #94: exact serving build identity from the attested handshake.
      ...(servingBuild === undefined ? {} : { buildIdentity: servingBuild }),
      service: installation === undefined
        ? { registered: false }
        : {
            registered: true,
            platform: installation.platform,
            serviceName: installation.serviceName,
            ...(detail === undefined
              ? {}
              : {
                  label: detail.label,
                  loadState: detail.loaded
                    ? detail.running
                      ? "running"
                      : detail.activeState === "failed" ? "failed" : "stopped"
                    : "not-loaded",
                  ...(detail.pid === undefined ? {} : { pid: detail.pid }),
                  ...(detail.enabled === undefined ? {} : { enabled: detail.enabled }),
                }),
          },
      host: config.gateway.host,
      port: config.gateway.port,
      managementPort: config.gateway.managementPort,
    }));
    return state.state === "attested-compatible" ? 0 : 1;
  }
  if (action === "stop") {
    await (dependencies.stopResidentRuntime ?? stopResidentRuntime)(config);
    console.log(JSON.stringify({ ok: true, stopped: true }));
    return 0;
  }
  const handle = await (dependencies.startResidentRuntime ?? startResidentRuntime)({ config });
  if (handle.alreadyRunning) {
    console.log(JSON.stringify({
      ok: true,
      running: true,
      resident: true,
      instanceId: handle.instanceId,
      runtimeVersion: handle.runtimeVersion,
    }));
    return 0;
  }
  console.log(JSON.stringify({
    ok: true,
    running: true,
    resident: true,
    instanceId: handle.instanceId,
    runtimeVersion: handle.runtimeVersion,
  }));
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void handle.shutdown().finally(() => { process.exitCode = 0; });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await handle.stopped;
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  return 0;
}
