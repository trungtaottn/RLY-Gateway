import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONTROL_PLANE_DB_NAME = "control-plane.sqlite";
export const CONTROL_PLANE_LOCK_NAME = "control-plane.migrate.lock";
export const CONTROL_PLANE_MARKER_NAME = "control-plane.migrate.marker";
export const CONTROL_PLANE_BACKUP_DIRECTORY = "backups";
export const CREDENTIAL_DIRECTORY = "credentials";
export const CREDENTIAL_QUARANTINE_DIRECTORY = "quarantine";
export const CREDENTIAL_LOCK_DIRECTORY = "locks";
export const MANUAL_SELECTION_NAME = "manual-selection.json";
export const SELECTOR_AFFINITY_NAME = "selector-affinity.json";
export const RESPONSES_DIRECTORY = "responses";
export const LOG_DIRECTORY = "logs";
export const SERVICE_LOG_NAME = "service.log";
export const RETENTION_MARKER_NAME = "retention.marker";
export const INSTALLATION_NAME = "installation.json";
export const RLY_STATE_DIRECTORY_NAME = ".rly";
export const LEGACY_STATE_DIRECTORY_NAME = ".agent-gateway";

export class StateRootMigrationError extends Error {
  override name = "StateRootMigrationError";
}

export type DefaultControlPlaneResolution = Readonly<{
  directory: string;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}>;

export function defaultControlPlaneDirectory(): string {
  return join(homedir(), RLY_STATE_DIRECTORY_NAME);
}

/** Resolves the default root and atomically moves a complete legacy state tree once. */
export async function resolveDefaultControlPlaneDirectory(home = homedir()): Promise<DefaultControlPlaneResolution> {
  const directory = join(home, RLY_STATE_DIRECTORY_NAME);
  const legacy = join(home, LEGACY_STATE_DIRECTORY_NAME);
  const before = await stateRoots(directory, legacy);
  if (before.canonical && before.legacy) throw stateConflict(directory, legacy);
  if (!before.legacy) return settledResolution(directory);

  const lock = await acquireStateMigrationLock(join(home, ".rly-state-migration.lock"));
  const release = lock.release;
  try {
    const current = await stateRoots(directory, legacy);
    if (current.canonical && current.legacy) throw stateConflict(directory, legacy);
    if (!current.legacy) return settledResolution(directory);
    if (current.canonical) return settledResolution(directory);

    const manifest = await stateManifest(legacy);
    await rename(legacy, directory);
    try {
      if (!sameManifest(manifest, await stateManifest(directory))) {
        throw new StateRootMigrationError("migrated state verification failed; RLY did not start");
      }
    } catch (error) {
      await restoreLegacyRoot(directory, legacy, manifest);
      throw error;
    }
    let settled = false;
    return {
      directory,
      commit: async () => {
        if (settled) return;
        settled = true;
        await release();
      },
      rollback: async () => {
        if (settled) return;
        try {
          await restoreLegacyRoot(directory, legacy, manifest);
        } finally {
          settled = true;
          await release();
        }
      },
    };
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}

function settledResolution(directory: string): DefaultControlPlaneResolution {
  return { directory, commit: () => Promise.resolve(), rollback: () => Promise.resolve() };
}

async function stateRoots(directory: string, legacy: string): Promise<{ canonical: boolean; legacy: boolean }> {
  return { canonical: await isDirectory(directory), legacy: await isDirectory(legacy) };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new StateRootMigrationError(`state root is not a safe directory: ${path}`);
    }
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function stateConflict(directory: string, legacy: string): StateRootMigrationError {
  return new StateRootMigrationError(`both ${directory} and legacy ${legacy} exist; move or back up one root before starting RLY`);
}

type StateEntry = Readonly<{ path: string; type: "directory" | "file"; mode: number; size?: number; hash?: string }>;

async function stateManifest(root: string, relative = ""): Promise<readonly StateEntry[]> {
  const path = relative ? join(root, relative) : root;
  const details = await lstat(path);
  if (details.isSymbolicLink()) throw new StateRootMigrationError(`state migration refuses symlink: ${path}`);
  if (details.isDirectory()) {
    const entries: StateEntry[] = [{ path: relative, type: "directory", mode: details.mode & 0o777 }];
    for (const child of (await readdir(path)).sort()) entries.push(...await stateManifest(root, relative ? join(relative, child) : child));
    return entries;
  }
  if (!details.isFile()) throw new StateRootMigrationError(`state migration refuses non-file entry: ${path}`);
  const contents = await readFile(path);
  return [{ path: relative, type: "file", mode: details.mode & 0o777, size: contents.length, hash: createHash("sha256").update(contents).digest("hex") }];
}

function sameManifest(left: readonly StateEntry[], right: readonly StateEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function restoreLegacyRoot(directory: string, legacy: string, expected: readonly StateEntry[]): Promise<void> {
  if (await isDirectory(legacy)) throw stateConflict(directory, legacy);
  if (!sameManifest(expected, await stateManifest(directory))) {
    throw new StateRootMigrationError("migrated state changed before rollback; RLY refused to overwrite recovery data");
  }
  await rename(directory, legacy);
}

async function acquireStateMigrationLock(path: string): Promise<{ release: () => Promise<void> }> {
  const lockId = randomUUID();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(`${lockId}\n`);
      await handle.close();
      return {
        release: async () => {
          await unlink(path).catch((error: unknown) => {
            if (!isNotFound(error)) throw error;
          });
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new StateRootMigrationError("RLY state migration is already in progress; wait for it to finish before starting another RLY process");
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

export function controlPlanePaths(directory: string): Readonly<{
  directory: string;
  database: string;
  lock: string;
  marker: string;
  backups: string;
  credentials: string;
  credentialQuarantine: string;
  credentialLocks: string;
  manualSelection: string;
  selectorAffinity: string;
  responses: string;
  logs: string;
  retentionMarker: string;
  installation: string;
}> {
  const credentials = join(directory, CREDENTIAL_DIRECTORY);
  return {
    directory,
    database: join(directory, CONTROL_PLANE_DB_NAME),
    lock: join(directory, CONTROL_PLANE_LOCK_NAME),
    marker: join(directory, CONTROL_PLANE_MARKER_NAME),
    backups: join(directory, CONTROL_PLANE_BACKUP_DIRECTORY),
    credentials,
    credentialQuarantine: join(credentials, CREDENTIAL_QUARANTINE_DIRECTORY),
    credentialLocks: join(credentials, CREDENTIAL_LOCK_DIRECTORY),
    manualSelection: join(directory, MANUAL_SELECTION_NAME),
    selectorAffinity: join(directory, SELECTOR_AFFINITY_NAME),
    responses: join(directory, RESPONSES_DIRECTORY),
    logs: join(directory, LOG_DIRECTORY),
    retentionMarker: join(directory, RETENTION_MARKER_NAME),
    installation: join(directory, INSTALLATION_NAME),
  };
}
