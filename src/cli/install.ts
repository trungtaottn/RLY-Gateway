import { homedir } from "node:os";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify } from "smol-toml";
import { runInit } from "./init.js";
import { gatewayConfigSchema } from "../config/schema.js";
import { acquireVerifiedCandidate, hostTarget, verifyLocalAcquisition } from "../installer/acquire.js";
import { DEFAULT_ORIGIN } from "../installer/metadata.js";
import { AcquisitionStateStore } from "../installer/state.js";
import { AcquisitionError, CHANNEL_POLICIES, SUPPORTED_TARGETS, type ChannelPolicy, type ReleaseChannel, type SupportedTarget, type VerifiedCandidate } from "../installer/types.js";
import { bootstrapScriptPath } from "../runtime/bootstrap.js";
import { readInstallation } from "../storage/installation.js";
import { RLY_STATE_DIRECTORY_NAME } from "../storage/paths.js";
import { resolveChannelPolicy } from "./update.js";
import { readPrivateSymlinkTarget } from "../storage/private-files.js";

/**
 * `rly install` (#129) — the verified first-install / repair/reinstall path.
 *
 * First install: resolves the signed channel metadata + release manifest,
 * downloads and verifies the EXACT artifact (digest/signature/tree/
 * qualification), installs the stable #94 bootstrap + the #35 artifact
 * layout, registers the per-user service through the `rly init` contract
 * (never `dist/cli/init.js`), establishes the initial committed `active`
 * deployment from the verified artifact bytes, and guides `rly config`.
 *
 * Repair/reinstall on an existing installation: verifies ownership/build
 * identity and repairs missing/stale bootstrap + service definitions
 * idempotently; a foreign/unowned path or process is never overwritten.
 * A differing verified version is STAGED as an update candidate and handed to
 * Wave 4 (INSTALL != ACTIVATE): the serving `active` reference and the
 * resident service are never changed by this command.
 */

const DURABLE_CONFIG_NAME = "gateway.config.toml";

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export type InstallCommandOptions = Readonly<{
  configPath: string;
  /** Local tarball path (bootstrap-installer handoff); network acquisition otherwise. */
  artifact?: string;
  /** Signed metadata directory (bootstrap-installer handoff). */
  metadataDirectory?: string;
  channel: ChannelPolicy;
  channelExplicit: boolean;
  origin: string;
  target?: string;
  version?: string;
  home?: string;
}>;

export type InstallCommandDependencies = Readonly<{
  acquire?: (options: Parameters<typeof acquireVerifiedCandidate>[0]) => Promise<VerifiedCandidate>;
  verifyLocal?: (options: Parameters<typeof verifyLocalAcquisition>[0]) => Promise<VerifiedCandidate>;
  runInit?: (configPath: string, dependencies?: Parameters<typeof runInit>[1]) => Promise<number>;
  resolveChannelPolicy?: (options: Readonly<{ channel: ChannelPolicy; channelExplicit: boolean; home: string }>) => Promise<Readonly<{ channel: ReleaseChannel; switched: boolean; previousChannel?: ReleaseChannel }>>;
}>;

export function parseInstallArgs(args: readonly string[], cwd: string): InstallCommandOptions {
  let configPath = resolve(cwd, "gateway.config.toml");
  let artifact: string | undefined;
  let metadataDirectory: string | undefined;
  let channel: ChannelPolicy = "current";
  let channelExplicit = false;
  let origin = DEFAULT_ORIGIN;
  let target: string | undefined;
  let version: string | undefined;
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
    if (token === "--artifact") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--artifact requires a tarball path");
      artifact = resolve(cwd, value);
      index += 2;
      continue;
    }
    if (token === "--metadata-dir") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--metadata-dir requires a directory");
      metadataDirectory = resolve(cwd, value);
      index += 2;
      continue;
    }
    if (token === "--channel") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || !(CHANNEL_POLICIES as readonly string[]).includes(value)) {
        throw new Error(`--channel requires one of ${CHANNEL_POLICIES.join("|")}`);
      }
      channel = value as ChannelPolicy;
      channelExplicit = channel !== "current";
      index += 2;
      continue;
    }
    if (token === "--origin") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--origin requires a URL");
      origin = value;
      index += 2;
      continue;
    }
    if (token === "--target") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--target requires a platform target");
      target = value;
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
    throw new Error(`unknown option ${token ?? "<missing>"}`);
  }
  return {
    configPath,
    ...(artifact === undefined ? {} : { artifact }),
    ...(metadataDirectory === undefined ? {} : { metadataDirectory }),
    channel,
    channelExplicit,
    origin,
    ...(target === undefined ? {} : { target }),
    ...(version === undefined ? {} : { version }),
  };
}

/**
 * Resolves the control-plane directory + platform target for an install.
 * Unsupported platforms fail with an actionable message before any mutation.
 */
export async function resolveInstallContext(
  options: Readonly<{ home: string; target?: string; origin: string; channel: ChannelPolicy; channelExplicit: boolean; version?: string }>,
  dependencies: InstallCommandDependencies = {},
): Promise<{ controlPlaneDirectory: string; target: SupportedTarget; policy: { channel: ReleaseChannel; switched: boolean; previousChannel?: ReleaseChannel } }> {
  const targetValue = options.target ?? hostTarget() ?? "";
  if (!(SUPPORTED_TARGETS.includes(targetValue as SupportedTarget))) {
    throw new AcquisitionError(
      "unsupported-platform",
      `unsupported platform/target ${targetValue || `${process.platform}-${process.arch}`}; RLY artifacts are published for darwin-arm64, darwin-x64, linux-x64, linux-arm64. Install only what the #35/#128 matrix promotes`,
    );
  }
  const policy = await (dependencies.resolveChannelPolicy ?? resolveChannelPolicy)(
    { channel: options.channel, channelExplicit: options.channelExplicit, home: options.home },
  );
  return {
    controlPlaneDirectory: join(options.home, RLY_STATE_DIRECTORY_NAME),
    target: targetValue as SupportedTarget,
    policy,
  };
}

/**
 * Acquires a verified candidate from the network channel or verifies the
 * bootstrap-installer handoff (`--artifact` + `--metadata-dir`).
 */
export async function acquireForInstall(
  options: Readonly<{
    channel: ReleaseChannel;
    target: SupportedTarget;
    origin: string;
    version?: string;
    artifact?: string;
    metadataDirectory?: string;
    stagingDirectory: string;
  }>,
  dependencies: InstallCommandDependencies = {},
): Promise<VerifiedCandidate> {
  if (options.artifact !== undefined) {
    if (options.metadataDirectory === undefined) {
      throw new AcquisitionError("candidate-invalid", "--artifact requires --metadata-dir with the signed channel metadata + release manifest");
    }
    return (dependencies.verifyLocal ?? verifyLocalAcquisition)({
      metadataDirectory: options.metadataDirectory,
      tarballPath: options.artifact,
      channel: options.channel,
      target: options.target,
    });
  }
  return (dependencies.acquire ?? acquireVerifiedCandidate)({
    origin: options.origin,
    channel: options.channel,
    target: options.target,
    ...(options.version === undefined ? {} : { version: options.version }),
    stagingDirectory: options.stagingDirectory,
  });
}

/**
 * Runs the first-install (fresh) path: writes the durable default config when
 * none is provided, then bootstraps the per-user service + initial committed
 * deployment from the verified artifact tree via the `rly init` contract.
 */
export async function firstInstall(
  options: Readonly<{ home: string; controlPlaneDirectory: string; candidate: VerifiedCandidate; configPath: string }>,
  dependencies: InstallCommandDependencies = {},
): Promise<{ code: number; configPath: string }> {
  const { writeFile, mkdir, chmod } = await import("node:fs/promises");
  const durableConfigPath = join(options.controlPlaneDirectory, DURABLE_CONFIG_NAME);
  await mkdir(options.controlPlaneDirectory, { recursive: true, mode: 0o700 });
  await chmod(options.controlPlaneDirectory, 0o700).catch(() => undefined);
  // The durable default config (schema defaults + the durable control-plane
  // directory) so `rly config` works from any working directory afterwards.
  const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: {}, controlPlane: { dataDirectory: options.controlPlaneDirectory } });
  await writeFile(durableConfigPath, `${stringify(config)}\n`, { mode: 0o600 });
  // An explicit `--config` is honored only when the file actually exists
  // (operator/dev path); a clean first install always uses the durable config.
  const explicitConfigPath = resolve(options.configPath);
  const initConfigPath = await isReadable(explicitConfigPath) ? explicitConfigPath : durableConfigPath;
  // First install may run/guide `rly init`: registers the per-user service
  // against the stable bootstrap and establishes the initial committed
  // `active` deployment from the verified artifact tree.
  const code = await (dependencies.runInit ?? runInit)(initConfigPath, {
    home: options.home,
    packageRoot: options.candidate.sourceDirectory,
  });
  return { code, configPath: initConfigPath };
}

/**
 * Repair/reinstall path for an existing installation: verifies ownership and
 * build identity, repairs missing/stale bootstrap + service definitions
 * idempotently, and never overwrites a foreign/unowned path. A verified
 * version that differs from the serving deployment is reported as an update
 * handoff (INSTALL != ACTIVATE — `rly update` owns staging/activation).
 */
export async function repairInstall(
  options: Readonly<{ home: string; controlPlaneDirectory: string; candidate: VerifiedCandidate; configPath: string }>,
  dependencies: InstallCommandDependencies = {},
): Promise<{ code: number; updated: boolean; message: string }> {
  const installation = await readInstallation(options.controlPlaneDirectory);
  const activeTarget = await readPrivateSymlinkTarget(join(options.controlPlaneDirectory, "runtime", "refs", "active")).catch(() => undefined);
  const servingArtifact = activeTarget === undefined ? undefined : /^\.\.\/versions\/([0-9a-f]{64})$/.exec(activeTarget)?.[1];
  // Ownership/build-identity verification: an existing install must be an
  // RLY-owned record with a stable bootstrap; a foreign/unowned path is never
  // overwritten.
  if (installation === undefined) {
    return { code: 1, updated: false, message: "no RLY installation record exists; run `rly install` on a clean home" };
  }
  if (servingArtifact === undefined) {
    return { code: 1, updated: false, message: "the installation has no committed active deployment; run `rly init` or `rly doctor` to recover" };
  }
  const sameArtifact = servingArtifact === options.candidate.artifactDigest;
  // Idempotent repair: re-run the init contract (detects/repairs missing or
  // stale bootstrap + service definitions; a valid committed deployment is
  // never rewritten, so the serving artifact never changes).
  const initConfigPath = installation.configPath;
  const code = await (dependencies.runInit ?? runInit)(initConfigPath, { home: options.home, packageRoot: options.candidate.sourceDirectory });
  if (code !== 0) {
    return { code, updated: false, message: "service repair failed; run `rly doctor`" };
  }
  return {
    code: 0,
    updated: !sameArtifact,
    message: sameArtifact
      ? `serving artifact ${servingArtifact.slice(0, 16)}… verified; bootstrap and service definitions repaired idempotently`
      : `verified update ${options.candidate.version} is available (serving ${servingArtifact.slice(0, 16)}…); run \`rly update --channel ${options.candidate.channel}\` to install and activate (INSTALL != ACTIVATE)`,
  };
}

/**
 * `rly install` entry: verified acquisition → first install or
 * repair/reinstall → acquisition audit log → next-steps guidance.
 */
export async function runInstallCommand(
  options: InstallCommandOptions,
  dependencies: InstallCommandDependencies = {},
): Promise<number> {
  const home = options.home ?? homedir();
  let controlPlaneDirectory: string;
  let target: SupportedTarget;
  let policy: { channel: ReleaseChannel; switched: boolean; previousChannel?: ReleaseChannel };
  let candidate: VerifiedCandidate;
  try {
    const context = await resolveInstallContext(
      {
        home,
        origin: options.origin,
        channel: options.channel,
        channelExplicit: options.channelExplicit,
        ...(options.target === undefined ? {} : { target: options.target }),
        ...(options.version === undefined ? {} : { version: options.version }),
      },
      dependencies,
    );
    controlPlaneDirectory = context.controlPlaneDirectory;
    target = context.target;
    policy = context.policy;
    const state = new AcquisitionStateStore(controlPlaneDirectory);
    candidate = await acquireForInstall(
      {
        channel: policy.channel,
        target,
        origin: options.origin,
        ...(options.version === undefined ? {} : { version: options.version }),
        ...(options.artifact === undefined ? {} : { artifact: options.artifact }),
        ...(options.metadataDirectory === undefined ? {} : { metadataDirectory: options.metadataDirectory }),
        stagingDirectory: join(controlPlaneDirectory, "installer", "staging"),
      },
      dependencies,
    );
    const highest = await state.highestObservedVersion(policy.channel);
    await state.recordObserved(policy.channel, Math.max(highest, candidate.metadataVersion));
    await state.appendAcquisition({
      schemaVersion: 1,
      at: new Date().toISOString(),
      kind: policy.switched ? "channel-switch" : "install",
      channel: candidate.channel,
      ...(policy.previousChannel === undefined ? {} : { previousChannel: policy.previousChannel }),
      version: candidate.version,
      target: candidate.target,
      sha256: candidate.sha256,
      artifactDigest: candidate.artifactDigest,
      metadataVersion: candidate.metadataVersion,
      verifiedAt: candidate.verifiedAt,
    });
  } catch (error) {
    const code = error instanceof AcquisitionError ? error.code : "unknown";
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "installation failed", code }));
    return 1;
  }

  const existing = await readInstallation(controlPlaneDirectory);
  if (existing === undefined) {
    const result = await firstInstall({ home, controlPlaneDirectory, candidate, configPath: options.configPath }, dependencies);
    if (result.code !== 0) {
      console.log(JSON.stringify({ ok: false, error: "the per-user service could not be registered; inspect the service log" }));
      return result.code;
    }
    console.log(JSON.stringify({
      ok: true,
      installed: true,
      version: candidate.version,
      channel: candidate.channel,
      target: candidate.target,
      artifactDigest: candidate.artifactDigest,
      verification: { channelMetadata: true, manifest: true, signature: true, digest: true, qualification: candidate.qualificationStatus },
      service: { registered: true, bootstrap: bootstrapScriptPath(controlPlaneDirectory) },
      configPath: result.configPath,
      message: "RLY installed and the per-user service is registered; run `rly config` to add providers/accounts/pools/profiles",
    }));
    return 0;
  }

  const repaired = await repairInstall({ home, controlPlaneDirectory, candidate, configPath: options.configPath }, dependencies);
  if (repaired.code !== 0) {
    console.log(JSON.stringify({ ok: false, error: repaired.message }));
    return repaired.code;
  }
  console.log(JSON.stringify({
    ok: true,
    installed: true,
    reinitialized: true,
    version: candidate.version,
    channel: candidate.channel,
    target: candidate.target,
    artifactDigest: candidate.artifactDigest,
    verification: { channelMetadata: true, manifest: true, signature: true, digest: true, qualification: candidate.qualificationStatus },
    repair: { verified: true, updated: repaired.updated, message: repaired.message },
    message: "run `rly doctor` or `rly update` for next steps",
  }));
  return 0;
}

