import type { UpdateStateRecord } from "./types.js";

/**
 * Deterministic CLI/runtime compatibility policy (#73). The package/CLI
 * version on disk is never proof of what the resident process is serving; the
 * attestation handshake (`/identity`) carries the serving runtime version and
 * the durable state/schema version, and this module decides whether an updated
 * CLI may keep talking to the old resident runtime while activation is pending.
 */

/** Management/data wire protocol version shared by CLI and runtime. */
export const RUNTIME_PROTOCOL_VERSION = 1;

/**
 * Runtime version compatibility for the pending-activation window. Same major
 * version ⇒ the old runtime's wire contract is compatible with the updated
 * CLI and new launches may continue on it until sessions drain. Different
 * major ⇒ only new launches are refused (existing sessions are never killed).
 */
export function runtimeProtocolCompatible(cliRuntimeVersion: string, runtimeVersion: string): boolean {
  return majorVersion(cliRuntimeVersion) === majorVersion(runtimeVersion);
}

export function majorVersion(version: string): number {
  const match = /^(\d+)/.exec(version.trim());
  const parsed = match === null ? undefined : Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(parsed) ? (parsed as number) : -1;
}

/**
 * Durable state/schema compatibility. The CLI may only drive migration or
 * activation when it understands the runtime's durable schema version.
 */
export function stateVersionsCompatible(cliStateVersion: number, runtimeStateVersion: number | undefined): boolean {
  return runtimeStateVersion === undefined || cliStateVersion === runtimeStateVersion;
}

export type LaunchPolicyDecision = Readonly<{
  allowed: boolean;
  /**
   * Actionable reason when refused: `update-pending` (activation installed but
   * not yet active) or `runtime-version-mismatch` (incompatible pair).
   */
  reason?: "update-pending" | "runtime-version-mismatch";
}>;

/**
 * New-launch policy while an update is pending or activating. Compatible pairs
 * may keep launching on the old runtime; incompatible pairs refuse ONLY new
 * launches with an actionable message — never touching existing sessions.
 */
export function launchPolicy(
  update: UpdateStateRecord | undefined,
  cliRuntimeVersion: string,
  runtimeVersion: string,
): LaunchPolicyDecision {
  if (update === undefined) return { allowed: true };
  if (update.state !== "pending-activation" && update.state !== "activating") return { allowed: true };
  if (runtimeProtocolCompatible(cliRuntimeVersion, runtimeVersion)) return { allowed: true };
  return {
    allowed: false,
    reason: majorVersion(cliRuntimeVersion) === -1 ? "runtime-version-mismatch" : "update-pending",
  };
}

/**
 * Blocks activation before any destructive state migration. A candidate that
 * declares a forward-only/unrollbackable migration must be refused before
 * changing durable state, with an actionable message; #35 owns artifact
 * authenticity, this is the lifecycle-side safety gate.
 */
export function migrationPreflight(update: UpdateStateRecord, migrationForwardOnly: boolean): string | undefined {
  if (!migrationForwardOnly) return undefined;
  return [
    "candidate migration is forward-only and rollback-unsafe",
    `(candidate ${update.pendingVersion ?? "unknown"} -> state would not be restorable)`,
    "update refused before activating; the previous version remains serving",
  ].join(" ");
}
