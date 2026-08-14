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

export function defaultControlPlaneDirectory(): string {
  return join(homedir(), ".agent-gateway");
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
  };
}
