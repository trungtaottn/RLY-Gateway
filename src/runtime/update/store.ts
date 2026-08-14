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
   * pid no longer matches its recorded start identity (process died) is
   * reclaimed; a live holder serializes the caller out with an actionable
   * error after a bounded retry.
   */
  public async acquireLock(): Promise<UpdateLock> {
    await this.initialize();
    const owner = { pid: process.pid, processStartedAt: new Date().toISOString() };
    return this.#acquireLock(owner);
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
    if (this.processIdentityLookup === undefined) return true; // conservative: unknown ⇒ held
    const observed = await this.processIdentityLookup(lock.owner.pid);
    return observed?.processStartedAt === lock.owner.processStartedAt;
  }
}

/**
 * Crash/reboot recovery mapping. Deterministic, secret-free, and conservative:
 * a stale `installing` is a failed install (re-run update); `pending-activation`
 * resumes once the candidate verifies; `activating` rolls back to the previous
 * known-good version (the rollback reference must survive the crash); any
 * state without the required references becomes `failed` with a doctor action.
 */
export function recoverUpdateState(record: UpdateStateRecord | undefined): UpdateStateRecord | undefined {
  if (record === undefined) return undefined;
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
