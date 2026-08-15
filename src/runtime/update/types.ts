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
  "recovery-required",
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

/**
 * Migration compatibility classes (#93) replacing the binary
 * `migrationForwardOnly` signal. A candidate declares how activating it
 * interacts with durable state so the lifecycle can prove rollback safety
 * BEFORE any destructive state change:
 *
 * - `none`: no durable state change; always rollback-safe.
 * - `backward-compatible-expand`: additive/expand-only state changes the
 *   previous known-good runtime can safely reopen; rollback-safe.
 * - `transactional-replace`: state is replaced transactionally with a durable
 *   rollback backup; rollback-safe by contract.
 * - `forward-only`: state changes make rollback unsafe; activation is blocked
 *   before destructive state mutation.
 */
export const MIGRATION_CLASSES = [
  "none",
  "backward-compatible-expand",
  "transactional-replace",
  "forward-only",
] as const;

export type MigrationClass = (typeof MIGRATION_CLASSES)[number];

export const migrationClassSchema = z.enum(MIGRATION_CLASSES);

/**
 * Durable activation-transaction journal phases (#93). The lifecycle moves
 * through these boundaries transactionally; a crash/reboot recovery makes one
 * deterministic choice from the durable phase and never guesses that a
 * candidate committed before COMMITTED is durable.
 */
export const TRANSACTION_PHASES = [
  "staged",
  "draining",
  "switching",
  "probation",
  "committing",
  "committed",
  "rolling-back",
  "recovery-required",
] as const;

export type TransactionPhase = (typeof TRANSACTION_PHASES)[number];

export const transactionPhaseSchema = z.enum(TRANSACTION_PHASES);

export const DEPLOYMENT_METADATA_FILE_NAME = ".rly-deployment.json";

export const deploymentMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  /** Content-addressed identity: sha256 over the deployed tree bytes. */
  artifactId: artifactIdSchema,
  product: z.string().min(1),
  /** Semantic version is metadata, never the storage key. */
  version: z.string().min(1),
  stateVersion: z.number().int().positive().optional(),
  /** Legacy #73 signal, superseded by `migrationClass` (#93). */
  migrationForwardOnly: z.boolean().optional(),
  /** Rollback compatibility class (#93); legacy manifests map to a class. */
  migrationClass: migrationClassSchema.optional(),
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
 * Durable activation-transaction journal (#93): one record per activation
 * attempt carrying the immutable deployment evidence needed for deterministic
 * crash recovery. Versions, digest identifiers, timestamps, and attempt counts
 * only — never credentials, prompts, responses, or account identity.
 */
export const updateTransactionSchema = z.object({
  schemaVersion: z.literal(1),
  phase: transactionPhaseSchema,
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** The staged candidate this transaction activates (or rolled back). */
  candidateVersion: z.string().min(1),
  candidateArtifactId: artifactIdSchema,
  /**
   * The known-good deployment displaced by this activation (rollback target).
   * Absent only when there was no serving deployment at transaction start
   * (first install), in which case a failure terminates in RECOVERY_REQUIRED.
   */
  previousVersion: z.string().min(1).optional(),
  previousArtifactId: artifactIdSchema.optional(),
  /** Durable bounded-rollback evidence: at most one attempt ever. */
  rollbackAttempts: z.number().int().min(0),
  lastRollbackOutcome: activationResultSchema.optional(),
  recoveryReason: z.string().optional(),
});

export type UpdateTransaction = z.infer<typeof updateTransactionSchema>;

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
  /**
   * Durable activation-transaction journal (#93): present while an
   * activation is (or was) transactional. Recovery reads ONLY this durable
   * evidence and never guesses that a candidate committed before the
   * `committed` phase was durable.
   */
  transaction: updateTransactionSchema.optional(),
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
   * Rollback compatibility class (#93). Absent ⇒ derived from the legacy
   * `migrationForwardOnly` signal: true ⇒ `forward-only`, false ⇒
   * `backward-compatible-expand`. `forward-only` candidates are blocked
   * before destructive activation with an actionable message.
   */
  migrationClass?: MigrationClass;
  /** Legacy #73 signal, superseded by `migrationClass` (#93). */
  migrationForwardOnly?: boolean;
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
  /**
   * Immutable deployment identity of the verified staged candidate (#93):
   * durable evidence for the activation-transaction journal recovery.
   */
  artifactId?: string;
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
  /**
   * #93 crash recovery: atomically re-establishes `active` (and `previous`)
   * from durable transaction evidence after an interrupted activation.
   * Previous is written before active so the known-good reference is never
   * lost mid-recovery.
   */
  setActiveReferences(input: Readonly<{ activeArtifactId: string; previousArtifactId?: string }>): Promise<void>;
  /** Reads the staged candidate's declared migration/schema manifest. */
  readManifest(): Promise<CandidateManifest | undefined>;
}
