import { z } from "zod";

/**
 * Durable update lifecycle states (#73). Installation and activation are
 * deliberately separate: an installed candidate is never considered active
 * until the restarted resident runtime passes identity/readiness checks.
 */
export const UPDATE_STATE_VALUES = [
  "idle",
  "installing",
  "pending-activation",
  "activating",
  "active",
  "rollback-required",
  "failed",
] as const;

export type UpdateState = (typeof UPDATE_STATE_VALUES)[number];

export const updateStateSchema = z.enum(UPDATE_STATE_VALUES);
export const UPDATE_STATE_FILE_NAME = "update-state.json";
export const UPDATE_LOCK_FILE_NAME = "update.lock";

/** Secret-free result of the last activation attempt. */
export type ActivationResult = Readonly<{
  ok: boolean;
  attemptedAt: string;
  reason?: string;
}>;

export const activationResultSchema = z.object({
  ok: z.boolean(),
  attemptedAt: z.iso.datetime(),
  reason: z.string().optional(),
});

/**
 * Durable update state record. Versions and timestamps only: never
 * credentials, tokens, prompts, responses, or account identity.
 */
export type UpdateStateRecord = z.infer<typeof updateStateRecordSchema>;

export const updateStateRecordSchema = z.object({
  schemaVersion: z.literal(1),
  state: updateStateSchema,
  currentVersion: z.string().min(1),
  pendingVersion: z.string().min(1).optional(),
  previousVersion: z.string().min(1).optional(),
  updatedAt: z.iso.datetime(),
  lastActivationResult: activationResultSchema.optional(),
  lastRollbackResult: activationResultSchema.optional(),
  failureReason: z.string().optional(),
});

/**
 * Secret-free metadata surfaced on `/identity` and in `rly status`/`doctor`.
 * `stateVersion` is the durable control-plane schema version the serving
 * runtime was built against (state/schema compatibility, not the CLI/package
 * version on disk).
 */
export type UpdateStateSnapshot = Readonly<{
  state: UpdateState;
  currentVersion: string;
  pendingVersion?: string;
  previousVersion?: string;
  stateVersion?: number;
  activeSessions: number;
  draining: boolean;
}>;

/**
 * Distribution-channel boundary (#73/#35). #73 owns the lifecycle once a
 * candidate is obtained/verified; #35 owns the signed/verified artifact
 * distribution channel. Tests and the local installer implement this contract
 * independently of packaging.
 */
export type CandidateManifest = Readonly<{
  product: string;
  version: string;
  /** Durable state/schema version the candidate requires (compatibility). */
  stateVersion: number;
  /**
   * True when activating this candidate permanently migrates durable state
   * such that rollback to the previous version is unsafe. Such candidates are
   * blocked before destructive activation with an actionable message.
   */
  migrationForwardOnly: boolean;
}>;

export type CandidateInstallResult = Readonly<{
  version: string;
  /** Previous known-good version preserved for rollback, when present. */
  previousVersion?: string;
}>;

export type CandidateVerification = Readonly<{
  ok: boolean;
  version: string;
  reason?: string;
}>;

export type InstallCandidateInput = Readonly<{
  version: string;
  /** Directory or artifact path containing the verified candidate. */
  sourceDirectory: string;
}>;

/**
 * Injectable candidate installer. The default local implementation swaps a
 * `current` → version symlink under the durable RLY state root and preserves a
 * `previous` reference; a future #35 channel plugs in here without changing the
 * drain/restart/verify/rollback state machine.
 */
export interface CandidateInstaller {
  installCandidate(input: InstallCandidateInput): Promise<CandidateInstallResult>;
  /** Verifies the currently selected candidate artifact is present/valid. */
  verifyCandidate(): Promise<CandidateVerification>;
  /** Restores the previous known-good version; fails when no reference exists. */
  restorePrevious(): Promise<CandidateInstallResult>;
  /** Reads the candidate's declared migration/schema manifest. */
  readManifest(): Promise<CandidateManifest | undefined>;
}
