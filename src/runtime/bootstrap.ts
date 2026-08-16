import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { BuildIdentity } from "./build-identity.js";
import { currentBuildIdentity } from "./build-identity.js";
import { RLY_SERVICE_NAME } from "../service-manager/types.js";
import type { ServiceDefinitionInput } from "../service-manager/types.js";
import {
  currentUid,
  ensurePrivateDirectory,
  isNotFound,
  PRIVATE_DIRECTORY_MODE,
  readPrivateSymlinkTarget,
  writePrivateTextAtomically,
} from "../storage/private-files.js";
import { runtimePaths } from "../storage/paths.js";
import { computeArtifactId, LocalCandidateInstaller } from "./update/installer.js";
import { DEPLOYMENT_METADATA_FILE_NAME, deploymentMetadataSchema, type DeploymentMetadata } from "./update/types.js";

/**
 * Stable RLY-owned bootstrap (#94). One installed executable/launcher target
 * under `<control-plane>/bootstrap/rly-gateway` is the ONLY execution identity
 * that per-user service managers (launchd/systemd) reference: the service
 * definition never points at `dist/cli/init.js`, a direct `runtime/refs/...`
 * deployment path, or the Node installation that happened to invoke
 * `rly init`.
 *
 * The bootstrap resolves ONLY the committed `active` deployment from the #92
 * immutable store and REFUSES staged/uncommitted/missing candidates. At boot
 * it validates the active reference and deployment layout before executing
 * `dist/cli/main.js` (the real dispatcher — `dist/cli/init.js` is a module,
 * not an entrypoint), and exports `RLY_SERVING_ARTIFACT` so the serving
 * runtime's `/identity` carries its exact artifact digest.
 */

export const BOOTSTRAP_DIRECTORY = "bootstrap";
export const BOOTSTRAP_SCRIPT_NAME = "rly-gateway";
export const BOOTSTRAP_NODE_FALLBACK_NAME = "node-path";
const REF_TARGET_PATTERN = "^../versions/[0-9a-f]{64}$";

export class BootstrapResolutionError extends Error {
  override name = "BootstrapResolutionError";
}

export type ActiveDeployment = Readonly<{
  /** Content-addressed immutable deployment identity (#92). */
  artifactId: string;
  deploymentDirectory: string;
  entrypoint: string;
  version: string;
}>;

export function bootstrapDirectory(controlPlaneDirectory: string): string {
  return join(controlPlaneDirectory, BOOTSTRAP_DIRECTORY);
}

export function bootstrapScriptPath(controlPlaneDirectory: string): string {
  return join(bootstrapDirectory(controlPlaneDirectory), BOOTSTRAP_SCRIPT_NAME);
}

/**
 * POSIX-sh launcher content. Self-locating (derives the control-plane root
 * from its own path), resolves the committed `active` deployment only, refuses
 * anything else with an actionable message, then execs the real dispatcher.
 * Node resolution is the bootstrap's own implementation detail (RLY_NODE →
 * PATH → recorded install-time fallback, re-validated); the service
 * definition never hardcodes node.
 */
export function buildBootstrapScript(): string {
  const hex = "[0-9a-f]".repeat(64);
  return `#!/bin/sh
# RLY Gateway stable bootstrap (#94).
#
# One installed RLY-owned launcher target for per-user service managers
# (launchd/systemd). It resolves ONLY the committed \`active\` deployment from
# the immutable runtime store (#92) and REFUSES staged/uncommitted/missing
# candidates. The service definition never references dist/cli/init.js, a
# direct runtime/refs/... path, or the Node installation that happened to
# invoke \`rly init\`.
set -u

RLY_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ACTIVE_REF="$RLY_ROOT/runtime/refs/active"
TARGET=""
DEPLOY=""
SERVING_ARTIFACT=""

if [ -L "$ACTIVE_REF" ]; then
  TARGET="$(readlink "$ACTIVE_REF" 2>/dev/null || true)"
  case "$TARGET" in
    ../versions/${hex})
      SERVING_ARTIFACT="\${TARGET#../versions/}"
      DEPLOY="$RLY_ROOT/runtime/versions/$SERVING_ARTIFACT"
      ;;
    *)
      DEPLOY=""
      ;;
  esac
fi

if [ -z "$DEPLOY" ] || [ ! -f "$DEPLOY/dist/cli/main.js" ]; then
  echo "RLY bootstrap: no committed active deployment (ref=$ACTIVE_REF, target=\${TARGET:-<missing>}); refusing to start from a staged or uncommitted runtime" >&2
  echo "run 'rly init' or 'rly update' to establish an active deployment" >&2
  exit 78
fi

NODE_BIN="\${RLY_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ] && [ -f "$RLY_ROOT/bootstrap/node-path" ]; then
  NODE_BIN="$(cat "$RLY_ROOT/bootstrap/node-path" 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ] || ! "$NODE_BIN" --version >/dev/null 2>&1; then
  echo "RLY bootstrap: no usable node binary (set RLY_NODE, ensure node is on PATH, or re-run rly init)" >&2
  exit 78
fi

export RLY_SERVING_ARTIFACT="$SERVING_ARTIFACT"
exec "$NODE_BIN" "$DEPLOY/dist/cli/main.js" "$@"
`;
}

/**
 * Idempotently installs the stable bootstrap script (0700 dir / 0755 file,
 * owner-executable) and records the install-time Node fallback (re-validated
 * at runtime by the script; never part of the service definition contract).
 * Returns the bootstrap script path.
 */
export async function writeBootstrapScript(controlPlaneDirectory: string): Promise<string> {
  const directory = bootstrapDirectory(controlPlaneDirectory);
  await ensurePrivateDirectory(directory);
  const content = buildBootstrapScript();
  const path = bootstrapScriptPath(controlPlaneDirectory);
  const previous = await readFile(path, "utf8").catch(() => undefined);
  if (previous !== content) {
    await writePrivateTextAtomically(path, content);
    await chmod(path, 0o755);
  }
  await writePrivateTextAtomically(join(directory, BOOTSTRAP_NODE_FALLBACK_NAME), `${process.execPath}\n`);
  return path;
}

/** The service definition for the stable bootstrap contract (no entrypoint). */
export function bootstrapServiceDefinition(
  controlPlaneDirectory: string,
  configPath: string,
  logPath?: string,
): ServiceDefinitionInput {
  return {
    serviceName: RLY_SERVICE_NAME,
    executable: bootstrapScriptPath(controlPlaneDirectory),
    configPath,
    ...(logPath === undefined ? {} : { logPath }),
  };
}

/**
 * Resolves the committed `active` deployment (#92) with full validation and
 * REFUSES staged/uncommitted/missing candidates: the active reference must be
 * a current-user symlink pointing at `../versions/<64-hex-artifactId>`, the
 * deployment directory must be a real current-user 0700 directory whose
 * `.rly-deployment.json` identity matches, and the real dispatcher
 * `dist/cli/main.js` must exist.
 */
export async function resolveActiveDeployment(controlPlaneDirectory: string): Promise<ActiveDeployment> {
  const paths = runtimePaths(controlPlaneDirectory);
  const target = await readPrivateSymlinkTarget(paths.active).catch(() => undefined);
  if (target === undefined) {
    throw new BootstrapResolutionError(
      "no committed active deployment (refs/active is missing); the bootstrap refuses staged/uncommitted candidates — run rly init or rly update",
    );
  }
  const match = /^\.\.\/versions\/([0-9a-f]{64})$/.exec(target);
  if (match === null) {
    throw new BootstrapResolutionError(`active reference ${target} is not a valid immutable deployment; run rly doctor`);
  }
  const artifactId = match[1] ?? "";
  const deploymentDirectory = join(paths.versions, artifactId);
  const details = await lstat(deploymentDirectory).catch((error: unknown) => {
    if (isNotFound(error)) {
      throw new BootstrapResolutionError(`active deployment is missing: ${deploymentDirectory}; run rly doctor`);
    }
    throw error;
  });
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new BootstrapResolutionError(`active deployment is not a real directory: ${deploymentDirectory}; run rly doctor`);
  }
  if (details.uid !== currentUid() || (details.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new BootstrapResolutionError(`active deployment must be a current-user private (0700) directory: ${deploymentDirectory}; run rly doctor`);
  }
  const metadata = await readDeploymentMetadata(deploymentDirectory);
  if (metadata.artifactId !== artifactId) {
    throw new BootstrapResolutionError(
      `active deployment metadata identity ${metadata.artifactId} does not match its directory ${artifactId}; run rly doctor`,
    );
  }
  const entrypoint = join(deploymentDirectory, "dist", "cli", "main.js");
  if (!(await isFile(entrypoint))) {
    throw new BootstrapResolutionError(`active deployment is missing its dispatcher entrypoint: ${entrypoint}; run rly doctor`);
  }
  return { artifactId, deploymentDirectory, entrypoint, version: metadata.version };
}

/** Reads and validates the deployment metadata; fails closed when malformed. */
export async function readDeploymentMetadata(directory: string): Promise<DeploymentMetadata> {
  const path = join(directory, DEPLOYMENT_METADATA_FILE_NAME);
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) {
      throw new BootstrapResolutionError(`deployment metadata is missing: ${path}; run rly doctor`);
    }
    throw error;
  }
  const parsed = deploymentMetadataSchema.safeParse(JSON.parse(contents) as unknown);
  if (!parsed.success) {
    throw new BootstrapResolutionError(`deployment metadata is malformed: ${path}; run rly doctor`);
  }
  return parsed.data;
}

/**
 * Establishes the INITIAL committed `active` deployment from the installed
 * RLY runtime tree (package.json + dist + node_modules + LICENSE + rly.json),
 * materialized with symlinks dereferenced so the tree is self-contained and
 * digest-deterministic. Idempotent: a valid committed active deployment is
 * left untouched (re-init/doctor never re-copies or rewrites immutable bytes).
 * Returns `{ created: false }` when a committed deployment already exists.
 */
export type EnsureInitialDeploymentOptions = Readonly<{
  packageRoot?: string;
  identity?: BuildIdentity;
  installer?: LocalCandidateInstaller;
}>;

export async function ensureInitialActiveDeployment(
  controlPlaneDirectory: string,
  options: EnsureInitialDeploymentOptions = {},
): Promise<{ created: boolean; artifactId: string }> {
  try {
    const existing = await resolveActiveDeployment(controlPlaneDirectory);
    return { created: false, artifactId: existing.artifactId };
  } catch (error) {
    if (!(error instanceof BootstrapResolutionError)) throw error;
  }
  const packageRoot = options.packageRoot ?? runtimePackageRoot();
  if (packageRoot === undefined) {
    throw new BootstrapResolutionError("cannot locate the RLY runtime tree to bootstrap the initial deployment; run rly update with a candidate");
  }
  const installer = options.installer ?? new LocalCandidateInstaller({ directory: controlPlaneDirectory });
  const paths = runtimePaths(controlPlaneDirectory);
  await ensurePrivateDirectory(paths.versions);
  const staging = join(paths.versions, `.staging-${randomUUID()}`);
  try {
    await materializeRuntimeTree(packageRoot, staging);
    const artifactId = await computeArtifactId(staging);
    const target = join(paths.versions, artifactId);
    if (await isRealDirectory(target)) {
      await rm(staging, { recursive: true, force: true });
    } else {
      await chmod(staging, PRIVATE_DIRECTORY_MODE);
      await rename(staging, target);
    }
    const identity = options.identity ?? await currentBuildIdentity();
    const metadata: DeploymentMetadata = {
      schemaVersion: 1,
      artifactId,
      product: "rly-gateway",
      version: identity.semanticVersion,
      stateVersion: identity.stateSchemaVersion,
      migrationClass: "backward-compatible-expand",
      buildId: identity.buildId,
      commitRevision: identity.commitRevision,
      releaseChannel: identity.releaseChannel,
      installedAt: new Date().toISOString(),
    };
    // Never rewrite an existing deployment's metadata (immutable store rule):
    // backfill only when the target lacks a matching record (crash retry).
    const existingMetadata = await readDeploymentMetadata(target).catch(() => undefined);
    if (existingMetadata === undefined || existingMetadata.artifactId !== artifactId) {
      await writePrivateTextAtomically(join(target, DEPLOYMENT_METADATA_FILE_NAME), `${JSON.stringify(metadata)}\n`);
    }
    await installer.setActiveReferences({ activeArtifactId: artifactId });
    return { created: true, artifactId };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Resolves the package root of the currently executing RLY tree (works for
 * both `dist/` builds and `src/` runs): `<root>/dist/cli/main.js` ⇒ `<root>`.
 */
export function runtimePackageRoot(): string | undefined {
  const path = fileURLToPath(import.meta.url);
  return join(dirname(path), "..", "..");
}

/**
 * Copies the allowlisted runtime tree (package.json, dist, node_modules,
 * LICENSE, rly.json) with symlinks dereferenced (pnpm node_modules uses
 * symlinks; deployments must be self-contained real files so the artifact
 * digest is deterministic and the deployed runtime never depends on the
 * source tree). Cycle-safe via a visited-realpath set; private 0700 dirs /
 * 0600 files.
 */
const INITIAL_DEPLOYMENT_ALLOWLIST = ["package.json", "dist", "node_modules", "LICENSE", "rly.json"] as const;

export async function materializeRuntimeTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(target, PRIVATE_DIRECTORY_MODE);
  const visited = new Set<string>();
  for (const name of INITIAL_DEPLOYMENT_ALLOWLIST) {
    await copyEntry(join(source, name), join(target, name), visited);
  }
  await chmod(target, PRIVATE_DIRECTORY_MODE);
}

async function copyEntry(source: string, target: string, visited: Set<string>): Promise<void> {
  const details = await lstat(source).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (details === undefined) return;
  if (details.isSymbolicLink()) {
    const resolved = await realpath(source);
    const key = `${source}\0${resolved}`;
    if (visited.has(key)) return; // cycle guard
    visited.add(key);
    await copyEntry(resolved, target, visited);
    return;
  }
  if (details.isDirectory()) {
    await mkdir(target, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(target, PRIVATE_DIRECTORY_MODE);
    const children = await readdir(source);
    for (const child of children.sort()) {
      await copyEntry(join(source, child), join(target, child), visited);
    }
    return;
  }
  if (details.isFile()) {
    await copyFile(source, target);
    await chmod(target, 0o600);
    return;
  }
  // Sockets/fifos/device nodes cannot be part of a deterministic deployment.
  throw new BootstrapResolutionError(`runtime tree contains a non-file entry (${source}); refusing to bootstrap an initial deployment`);
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    return details.isDirectory() && !details.isSymbolicLink();
  } catch (error: unknown) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    return details.isFile() && !details.isSymbolicLink();
  } catch (error: unknown) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Zod schema used to validate the active ref target shape (unit-test surface). */
export const activeRefTargetSchema: z.ZodType<string> = z.string().regex(new RegExp(REF_TARGET_PATTERN));
