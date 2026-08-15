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

/**
 * Immutable deployment artifact identity (#92): a full SHA-256 over the
 * candidate's exact artifact bytes/build tree, so byte-distinct candidates
 * always receive distinct identities and semantic version is metadata only.
 */
export const artifactIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const DEPLOYMENT_METADATA_FILE_NAME = ".rly-deployment.json";

export const deploymentMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  /** Content-addressed identity: sha256 over the deployed tree bytes. */
  artifactId: artifactIdSchema,
  product: z.string().min(1),
  /** Semantic version is metadata, never the storage key. */
  version: z.string().min(1),
  stateVersion: z.number().int().positive().optional(),
  migrationForwardOnly: z.boolean().optional(),
  installedAt: z.iso.datetime(),
});

/**
 * Secret-free per-deployment metadata written into an immutable deployment.
 * Identifiers only (product/version/stateVersion/digest/path); never
 * credentials, auth headers, account identity, prompts, responses, or
 * reasoning text.
 */
export type DeploymentMetadata = z.infer<typeof deploymentMetadataSchema>;

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
  /** Immutable deployment identities (#92): semver remains metadata only. */
  currentArtifactId: artifactIdSchema.optional(),
  pendingArtifactId: artifactIdSchema.optional(),
  previousArtifactId: artifactIdSchema.optional(),
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
  /** Content-addressed immutable deployment identity (#92). */
  artifactId: string;
  /** Previous known-good version preserved for rollback, when present. */
  previousVersion?: string;
  /** Immutable identity of the previous known-good deployment, when present. */
  previousArtifactId?: string;
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
 * Injectable candidate installer. The default local implementation stores
 * immutable content-addressed deployments under `<control-plane>/runtime/
 * versions/<artifactId>` and maintains explicit `staged`/`active`/`previous`
 * references under `runtime/refs/` replaced atomically (temp-create + rename +
 * parent fsync). Installing a candidate may update only `staged`; switching
 * `active` is an explicit activation transition (`activateStaged`) that #93
 * will gate transactionally. A future #35 channel plugs in here without
 * changing the drain/restart/verify/rollback state machine.
 */
export interface CandidateInstaller {
  installCandidate(input: InstallCandidateInput): Promise<CandidateInstallResult>;
  /**
   * Atomically switches the `active` reference to the staged deployment and
   * preserves the displaced deployment as `previous` (INSTALL != ACTIVATE;
   * #93 owns the transactional gate around this primitive).
   */
  activateStaged(): Promise<CandidateInstallResult>;
  /** Verifies the currently staged candidate artifact is present/valid. */
  verifyCandidate(): Promise<CandidateVerification>;
  /** Restores the previous known-good version; fails when no reference exists. */
  restorePrevious(): Promise<CandidateInstallResult>;
  /** Reads the staged candidate's declared migration/schema manifest. */
  readManifest(): Promise<CandidateManifest | undefined>;
}
