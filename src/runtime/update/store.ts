import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ensurePrivateDirectory,
  isAlreadyExists,
  isNotFound,
  PRIVATE_FILE_MODE,
  readPrivateTextIfPresent,
  writePrivateTextAtomically,
} from "../../storage/private-files.js";
import {
  UPDATE_LOCK_FILE_NAME,
  UPDATE_STATE_FILE_NAME,
  updateStateRecordSchema,
  type UpdateState,
  type UpdateStateRecord,
} from "./types.js";

/**
 * Durable update-state store with CAS transitions and an ownership-aware
 * update lock. Only one update/activation may be active per user runtime; the
 * lock mirrors the runtime startup-lock recovery rule (pid + process start
 * identity; a stale lock whose owner process no longer matches is reclaimed).
 * All files are private (0700 dir / 0600 atomic files), refuse links, and
 * contain versions/timestamps only — never credentials or identity.
 */

const updateLockSchema = z.object({
  lockId: z.uuid(),
  createdAt: z.iso.datetime(),
  owner: z.object({
    pid: z.number().int().positive(),
    processStartedAt: z.iso.datetime(),
    /**
     * #93: true when `processStartedAt` is the real OS process-start identity
     * (from the process-attestation subsystem), false for the conservative
     * wall-clock fallback. A lock whose identity is unverifiable is never
     * reclaimed from owner-identity evidence alone.
     */
    identityVerified: z.boolean().optional(),
  }),
});

export type UpdateLockRecord = z.infer<typeof updateLockSchema>;
export type ProcessIdentityLookup = (pid: number) => Promise<{ processStartedAt: string } | undefined> | { processStartedAt: string } | undefined;

export class UpdateStateError extends Error {
  override name = "UpdateStateError";
}

export class UpdateLockUnavailableError extends UpdateStateError {
  override name = "UpdateLockUnavailableError";
}

export class UpdateLock {
  #released = false;

  public constructor(
    readonly path: string,
    readonly lock: UpdateLockRecord,
  ) {}

  public async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    const current = await readJsonIfPresent(this.path, updateLockSchema);
    if (current?.value.lockId === this.lock.lockId) {
      await rmQuietly(this.path);
    }
  }
}

export class UpdateStateStore {
  readonly statePath: string;
  readonly lockPath: string;

  public constructor(
    readonly directory: string,
    private readonly processIdentityLookup?: ProcessIdentityLookup,
  ) {
    this.statePath = join(directory, UPDATE_STATE_FILE_NAME);
    this.lockPath = join(directory, UPDATE_LOCK_FILE_NAME);
  }

  public async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
  }

  /**
   * Reads the durable update state. Missing ⇒ undefined (no update in
   * progress). Malformed state fails closed (never trusted) rather than being
   * silently reset, mirroring the canary artifact rule.
   */
  public async read(): Promise<UpdateStateRecord | undefined> {
    await this.initialize();
    const current = await readJsonIfPresent(this.statePath, updateStateRecordSchema);
    return current?.value;
  }

  public async write(record: UpdateStateRecord): Promise<void> {
    updateStateRecordSchema.parse(record);
    await this.initialize();
    await writePrivateTextAtomically(this.statePath, `${JSON.stringify(record)}\n`);
  }

  public async clear(): Promise<void> {
    await this.initialize();
    await rmQuietly(this.statePath);
  }

  /**
   * CAS transition: applies `update` only when the current state matches one
   * of `from` (or unconditionally when `from` is empty). Serialized by the
   * update lock so two `rly update` invocations cannot race the state machine.
   */
  public async transition(
    from: readonly (UpdateState | "none")[],
    update: (current: UpdateStateRecord | undefined) => UpdateStateRecord,
  ): Promise<UpdateStateRecord> {
    await this.initialize();
    const lock = await this.acquireLock();
    try {
      return await this.transitionUnderLock(from, update);
    } finally {
      await lock.release();
    }
  }

  /**
   * CAS transition for callers that already hold the update lock (the #73
   * coordinator holds it for the whole run), so nested transitions do not
   * deadlock against the same process's lock.
   */
  public async transitionUnderLock(
    from: readonly (UpdateState | "none")[],
    update: (current: UpdateStateRecord | undefined) => UpdateStateRecord,
  ): Promise<UpdateStateRecord> {
    await this.initialize();
    const current = await this.read();
    const observed: UpdateState | "none" = current?.state ?? "none";
    if (from.length > 0 && !from.includes(observed)) {
      throw new UpdateStateError(
        `update state transition blocked: expected ${from.join("|")}, found ${observed}`,
      );
    }
    const next = updateStateRecordSchema.parse(update(current));
    await this.write(next);
    return next;
  }

  /**
   * Acquires the update lock with stale-owner attestation. A lock whose owner
   * pid no longer matches its recorded OS process-start identity (process
   * died) is reclaimed; a live holder serializes the caller out with an
   * actionable error after a bounded retry. #93: the recorded identity is the
   * REAL OS process-start identity from the process-attestation subsystem
   * (never acquisition wall-clock time), so a live lock owned by another RLY
   * process is never misclassified as stale. When identity cannot be
   * verified the lock is conservatively treated as held.
   */
  public async acquireLock(): Promise<UpdateLock> {
    await this.initialize();
    const owner = await this.#currentOwnerIdentity();
    return this.#acquireLock(owner);
  }

  async #currentOwnerIdentity(): Promise<UpdateLockRecord["owner"]> {
    if (this.processIdentityLookup === undefined) {
      // No attestation subsystem available: conservative unverifiable fallback.
      return { pid: process.pid, processStartedAt: new Date().toISOString(), identityVerified: false };
    }
    const observed = await this.processIdentityLookup(process.pid);
    if (observed === undefined) {
      // Own identity unreadable: record the fallback but mark it unverifiable
      // so a later stale-check never reclaims on a mismatched wall clock.
      return { pid: process.pid, processStartedAt: new Date().toISOString(), identityVerified: false };
    }
    return { pid: process.pid, processStartedAt: observed.processStartedAt, identityVerified: true };
  }

  async #acquireLock(owner: UpdateLockRecord["owner"]): Promise<UpdateLock> {
    const lock: UpdateLockRecord = {
      lockId: randomUUID(),
      createdAt: new Date().toISOString(),
      owner,
    };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const acquired = await tryCreateLock(this.lockPath, lock);
      if (acquired) return new UpdateLock(this.lockPath, lock);
      const existing = await readJsonIfPresent(this.lockPath, updateLockSchema);
      const stale = existing === undefined || !(await this.#ownerAlive(existing.value));
      if (!stale) throw new UpdateLockUnavailableError("another RLY update is already in progress; wait for it to finish");
      if (existing !== undefined) await unlinkIfUnchanged(this.lockPath, existing.contentsHash);
    }
    throw new UpdateLockUnavailableError("the RLY update lock could not be acquired");
  }

  async #ownerAlive(lock: UpdateLockRecord): Promise<boolean> {
    if (lock.owner.pid === process.pid) return true;
    // #93: an identity that was never verified (wall-clock fallback) cannot be
    // compared to a process lookup, so it is conservatively treated as held —
    // never reclaimed from a mismatched timestamp alone.
    if (lock.owner.identityVerified === false) return true;
    if (this.processIdentityLookup === undefined) return true; // conservative: unknown ⇒ held
    const observed = await this.processIdentityLookup(lock.owner.pid);
    if (observed === undefined) return false; // proven dead: pid no longer in the process table
    return observed.processStartedAt === lock.owner.processStartedAt;
  }

  /**
   * #93: secret-free lock-owner status for `rly status`/`rly doctor` — held,
   * owning pid, and whether the owner identity is proven stale/dead (reclaim
   * would be safe). Never PID-only evidence.
   */
  public async lockStatus(): Promise<Readonly<{ held: boolean; ownerPid?: number; stale?: boolean }>> {
    await this.initialize();
    const existing = await readJsonIfPresent(this.lockPath, updateLockSchema).catch(() => undefined);
    if (existing === undefined) return { held: false };
    const alive = await this.#ownerAlive(existing.value);
    return {
      held: true,
      ownerPid: existing.value.owner.pid,
      ...(alive ? {} : { stale: true }),
    };
  }
}

/**
 * Crash/reboot recovery mapping (#73/#93). Deterministic, secret-free, and
 * conservative. When a durable activation-transaction journal is present the
 * phase is the only authority and the lifecycle NEVER guesses that a candidate
 * committed before the `committed` phase was durable:
 *
 * - `staged`/`draining`: nothing was switched yet ⇒ resume activation.
 * - `switching`/`probation`/`committing`: the candidate is NOT committed ⇒
 *   roll back to the durable previous known-good reference.
 * - `rolling-back`: one bounded rollback attempt may resume; a second
 *   interruption is terminal (`recovery-required`).
 * - `committed`: the transaction is durable ⇒ promote to `active`.
 * - `recovery-required`: terminal; `rly doctor` only.
 *
 * Without a journal the legacy #73 mapping is preserved: stale `installing` is
 * a failed install (re-run update); `pending-activation` resumes once the
 * candidate verifies; interrupted `activating` rolls back to the previous
 * known-good version; any state without the required references becomes
 * `failed` with a doctor action.
 */
export function recoverUpdateState(record: UpdateStateRecord | undefined): UpdateStateRecord | undefined {
  if (record === undefined) return undefined;
  if (record.transaction !== undefined) return recoverTransaction(record);
  switch (record.state) {
    case "installing":
      return { ...record, state: "failed", failureReason: "update installation was interrupted; re-run rly update to retry" };
    case "pending-activation":
      if (record.pendingVersion === undefined) {
        return { ...record, state: "failed", failureReason: "pending activation lost its candidate reference; re-run rly update" };
      }
      return record;
    case "activating":
      if (record.previousVersion === undefined) {
        return { ...record, state: "failed", failureReason: "activation interrupted without a rollback reference; run rly doctor" };
      }
      return { ...record, state: "rollback-required", failureReason: "activation was interrupted; rollback to the previous version is required" };
    default:
      return record;
  }
}

function recoverTransaction(record: UpdateStateRecord): UpdateStateRecord {
  const transaction = record.transaction;
  if (transaction === undefined) return record;
  switch (transaction.phase) {
    case "committed": {
      // Durable commit evidence: the transaction finished; promote to active.
      return {
        ...record,
        state: "active" as const,
        currentVersion: transaction.candidateVersion,
        pendingVersion: undefined,
        currentArtifactId: transaction.candidateArtifactId,
        pendingArtifactId: undefined,
        ...(transaction.previousArtifactId === undefined
          ? { previousArtifactId: undefined }
          : { previousArtifactId: transaction.previousArtifactId }),
        lastActivationResult: { ok: true, attemptedAt: transaction.updatedAt },
        failureReason: undefined,
      };
    }
    case "staged":
    case "draining":
      // Pre-switch: the serving reference was never changed; resume activation.
      return { ...record, state: "pending-activation" as const, failureReason: undefined };
    case "switching":
    case "probation":
    case "committing":
      // Never guess the candidate committed: roll back to the known-good.
      return {
        ...record,
        state: "rollback-required" as const,
        failureReason: `activation transaction was interrupted during ${transaction.phase}; rollback to the previous known-good version is required`,
      };
    case "rolling-back":
      if (transaction.rollbackAttempts >= 1) {
        return {
          ...record,
          state: "recovery-required" as const,
          failureReason: "rollback was interrupted after the bounded attempt; run rly doctor",
        };
      }
      return {
        ...record,
        state: "rollback-required" as const,
        failureReason: "rollback was interrupted; one bounded rollback attempt will resume",
      };
    case "recovery-required":
      return { ...record, state: "recovery-required" as const };
    default:
      return record;
  }
}

async function tryCreateLock(path: string, lock: UpdateLockRecord): Promise<boolean> {
  try {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(lock)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, PRIVATE_FILE_MODE);
    return true;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    return false;
  }
}

async function readJsonIfPresent<T>(path: string, schema: z.ZodType<T>): Promise<{ value: T; contentsHash: string } | undefined> {
  const contents = await readPrivateTextIfPresent(path);
  if (contents === undefined) return undefined;
  const value: unknown = JSON.parse(contents) as unknown;
  return { value: schema.parse(value), contentsHash: hash(contents) };
}

async function unlinkIfUnchanged(path: string, expectedHash: string): Promise<void> {
  const current = await readPrivateTextIfPresent(path);
  if (current === undefined) return;
  if (hash(current) !== expectedHash) return;
  await rmQuietly(path);
}

async function rmQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
