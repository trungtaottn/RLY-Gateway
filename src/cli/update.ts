import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load-config.js";
import { RUNTIME_VERSION } from "../runtime/gateway-attestation.js";
import { bootstrapServiceDefinition, writeBootstrapScript } from "../runtime/bootstrap.js";
import { readCandidateManifestFromDirectory, LocalCandidateInstaller } from "../runtime/update/installer.js";
import { runUpdate, type UpdateRunResult } from "../runtime/update/lifecycle.js";
import { UpdateStateStore } from "../runtime/update/store.js";
import { createServiceManager } from "../service-manager/index.js";
import { readInstallation } from "../storage/installation.js";
import { defaultControlPlaneDirectory, LOG_DIRECTORY, SERVICE_LOG_NAME } from "../storage/paths.js";
import { SCHEMA_V2_VERSION } from "../storage/schema-v2.js";
import { readProcessIdentity } from "../runtime/process-identity.js";
import type { GatewayConfig } from "../config/schema.js";
import type { GatewayLeaseHandle } from "../runtime/gateway-lifecycle.js";
import { launchPolicy } from "../runtime/update/policy.js";

export type UpdateCommandOptions = Readonly<{
  configPath: string;
  candidate?: Readonly<{ sourceDirectory: string; version?: string }>;
  force: boolean;
  waitTimeoutMs: number;
}>;

export type UpdateCommandDependencies = Readonly<{
  loadConfig?: typeof loadConfig;
  runUpdate?: (dependencies: Parameters<typeof runUpdate>[0]) => Promise<UpdateRunResult>;
}>;

export function parseUpdateArgs(args: readonly string[], cwd: string): UpdateCommandOptions {
  let configPath = resolve(cwd, "gateway.config.toml");
  let candidateDirectory: string | undefined;
  let version: string | undefined;
  let force = false;
  let waitTimeoutMs = 60_000;
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === "--config") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--config requires a path");
      configPath = resolve(cwd, value);
      index += 2;
      continue;
    }
    if (token === "--candidate") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--candidate requires a candidate directory");
      candidateDirectory = resolve(cwd, value);
      index += 2;
      continue;
    }
    if (token === "--version") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--version requires a version");
      version = value;
      index += 2;
      continue;
    }
    if (token === "--wait-timeout") {
      const value = args[index + 1];
      const parsed = Number(value);
      if (value === undefined || !Number.isInteger(parsed) || parsed < 1) throw new Error("--wait-timeout requires a positive millisecond value");
      waitTimeoutMs = parsed;
      index += 2;
      continue;
    }
    if (token === "--force") {
      force = true;
      index += 1;
      continue;
    }
    throw new Error(`unknown option ${token ?? "<missing>"}`);
  }
  if (candidateDirectory !== undefined) {
    return { configPath, candidate: { sourceDirectory: candidateDirectory, ...(version === undefined ? {} : { version }) }, force, waitTimeoutMs };
  }
  if (version !== undefined) throw new Error("--version requires --candidate");
  return { configPath, force, waitTimeoutMs };
}

/**
 * `rly update`: installs a verified candidate while the old resident runtime
 * keeps serving, then activates through a controlled service-manager restart
 * at a safe drain point, verifies the new runtime, and rolls back on failure.
 * Without a candidate it resumes a pending activation (crash/reboot recovery)
 * or reports the current update state. Distribution/signing is #35; this
 * command owns the lifecycle once a candidate is obtained.
 */
export async function runUpdateCommand(
  options: UpdateCommandOptions,
  dependencies: UpdateCommandDependencies = {},
): Promise<number> {
  const config = await (dependencies.loadConfig ?? loadConfig)(options.configPath);
  const controlPlaneDirectory = config.controlPlane.dataDirectory ?? defaultControlPlaneDirectory();
  const installation = await readInstallation(controlPlaneDirectory);
  if (installation === undefined) {
    console.log(JSON.stringify({ ok: false, error: "RLY is not initialized; run `rly init` first" }));
    return 1;
  }
  const manager = createServiceManager({
    home: homedir(),
    logPath: join(controlPlaneDirectory, LOG_DIRECTORY, SERVICE_LOG_NAME),
    workingDirectory: controlPlaneDirectory,
  });
  if (!manager.isSupported()) {
    console.log(JSON.stringify({ ok: false, error: `per-user service management is not supported on platform ${manager.platform}; update activation requires the resident service` }));
    return 1;
  }
  const installer = new LocalCandidateInstaller({ directory: controlPlaneDirectory });
  const updateStore = new UpdateStateStore(controlPlaneDirectory, (pid) => readProcessIdentity(pid));
  // #94 stable bootstrap: the service definition references the RLY-owned
  // launcher (never dist/cli/init.js, never an incidental Node path, never a
  // direct runtime/refs/... path), so the controlled restart after the
  // `active` ref switch automatically boots the newly committed deployment.
  await writeBootstrapScript(controlPlaneDirectory);
  let candidate: Readonly<{ version: string; sourceDirectory: string }> | undefined;
  if (options.candidate !== undefined) {
    const manifest = await readCandidateManifestFromDirectory(options.candidate.sourceDirectory);
    const version = options.candidate.version ?? manifest?.version;
    if (version === undefined) {
      console.log(JSON.stringify({ ok: false, error: `candidate ${options.candidate.sourceDirectory} has no rly.json manifest and no --version` }));
      return 1;
    }
    candidate = { version, sourceDirectory: options.candidate.sourceDirectory };
  }
  const result = await (dependencies.runUpdate ?? runUpdate)({
    config,
    controlPlaneDirectory,
    installer,
    serviceManager: manager,
    serviceDefinition: bootstrapServiceDefinition(
      controlPlaneDirectory,
      installation.configPath,
      join(controlPlaneDirectory, LOG_DIRECTORY, SERVICE_LOG_NAME),
    ),
    ...(candidate === undefined ? {} : { candidate }),
    ...(options.force ? { force: true } : {}),
    drainTimeoutMs: options.waitTimeoutMs,
    updateStore,
    cliRuntimeVersion: RUNTIME_VERSION,
    cliStateVersion: SCHEMA_V2_VERSION,
  });
  console.log(JSON.stringify({
    ok: result.outcome !== "failed",
    state: result.state,
    outcome: result.outcome,
    currentVersion: result.currentVersion,
    ...(result.pendingVersion === undefined ? {} : { pendingVersion: result.pendingVersion }),
    ...(result.phase === undefined ? {} : { phase: result.phase }),
    ...(result.state === "recovery-required" ? { recovery: "manual" } : {}),
    ...(result.message === undefined ? {} : { message: result.message }),
  }));
  return result.outcome === "failed" ? 1 : 0;
}

/**
 * New-launch policy while an update is pending/activating (#73): a compatible
 * pair may keep launching on the old resident runtime; an incompatible pair
 * refuses NEW launches with an actionable message and never touches existing
 * sessions. Only enforced for resident handles (launcher-owned foreground
 * checkouts have no resident update lifecycle).
 */
export async function assertUpdateLaunchAllowed(
  lease: GatewayLeaseHandle,
  config: GatewayConfig,
): Promise<void> {
  if (lease.runtimeVersion === undefined) return;
  const controlPlaneDirectory = config.controlPlane.dataDirectory ?? defaultControlPlaneDirectory();
  const store = new UpdateStateStore(controlPlaneDirectory);
  const update = await store.read().catch(() => undefined);
  if (update === undefined) return;
  const decision = launchPolicy(update, RUNTIME_VERSION, lease.runtimeVersion);
  if (decision.allowed) return;
  throw new Error(
    `update-pending: the resident runtime (${lease.runtimeVersion}) is not protocol-compatible with this RLY (${RUNTIME_VERSION}) while activation is pending. `
    + "New launches are refused until the update activates; existing sessions are unaffected. "
    + "Run `rly update` to complete activation.",
  );
}
