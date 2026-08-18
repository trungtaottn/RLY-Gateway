import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  canReuseInstance,
  matchesProcessIdentity,
  ownershipRecordSchema,
  ownershipExpectationSchema,
  processIdentitySchema,
  type OwnershipExpectation,
  type OwnershipRecord,
  type ProcessIdentity,
} from "./ownership-record.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW_WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const NO_FOLLOW_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const instanceSecretSchema = z.string().min(1);

const startupLockSchema = z.object({
  lockId: z.uuid(),
  createdAt: z.iso.datetime(),
  owner: z.object({
    pid: z.number().int().positive(),
    processStartedAt: z.iso.datetime(),
  }),
});

export type StartupLockRecord = z.infer<typeof startupLockSchema>;
export type StaleLockAttestation = (lock: StartupLockRecord | undefined) => Promise<boolean> | boolean;
export type ProcessIdentityLookup = (pid: number) => Promise<ProcessIdentity | undefined> | ProcessIdentity | undefined;

export class RuntimeStoreError extends Error {
  override name = "RuntimeStoreError";
}

export class StartupLockUnavailableError extends RuntimeStoreError {
  override name = "StartupLockUnavailableError";
}

export class UnsafeRuntimePathError extends RuntimeStoreError {
  override name = "UnsafeRuntimePathError";
}

export type RuntimeStoreOptions = Readonly<{
  processIdentityLookup?: ProcessIdentityLookup;
}>;

export class RuntimeLock {
  #released = false;

  public constructor(
    readonly path: string,
    readonly lock: StartupLockRecord,
  ) {}

  public async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;

    const current = await readJsonIfPresent(this.path, startupLockSchema);
    if (current?.value.lockId === this.lock.lockId) {
      await unlink(this.path).catch((error: unknown) => {
        if (isNotFound(error)) return;
        throw error;
      });
    }
  }
}

/**
 * Stores the project-owned runtime record outside Git. Every file operation
 * refuses links; the parent directory is private so the check is stable after
 * it has been created.
 */
export class RuntimeStore {
  readonly ownershipPath: string;
  readonly secretPath: string;
  readonly managementSecretPath: string;
  readonly startupLockPath: string;
  readonly leaseLockPath: string;
  readonly #processIdentityLookup: ProcessIdentityLookup | undefined;

  public constructor(
    readonly directory: string,
    options: RuntimeStoreOptions = {},
  ) {
    this.ownershipPath = join(directory, "ownership.json");
    this.secretPath = join(directory, "instance.secret");
    this.managementSecretPath = join(directory, "management.secret");
    this.startupLockPath = join(directory, "startup.lock");
    this.leaseLockPath = join(directory, "leases.lock");
    this.#processIdentityLookup = options.processIdentityLookup;
  }

  public async initialize(): Promise<void> {
    let wasCreated = false;
    try {
      await lstat(this.directory);
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
      await mkdir(this.directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      wasCreated = true;
    }
    let details = await lstat(this.directory);
    if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== currentUid()) {
      throw new UnsafeRuntimePathError(`runtime directory is not a current-user private directory: ${this.directory}`);
    }
    if (wasCreated) {
      await chmod(this.directory, PRIVATE_DIRECTORY_MODE);
      details = await lstat(this.directory);
    }
    if (fileMode(details.mode) !== PRIVATE_DIRECTORY_MODE) {
      throw new UnsafeRuntimePathError(`runtime directory must use mode 0700: ${this.directory}`);
    }
  }

  public async acquireStartupLock(
    owner: ProcessIdentity,
    attestStaleLock?: StaleLockAttestation,
  ): Promise<RuntimeLock> {
    processIdentitySchema.parse(owner);
    await this.initialize();
    return this.#acquireLock(this.startupLockPath, owner, attestStaleLock);
  }

  public async writeOwnershipRecord(record: OwnershipRecord): Promise<void> {
    ownershipRecordSchema.parse(record);
    await this.initialize();
    await writePrivateJsonAtomically(this.ownershipPath, record);
  }

  public async readOwnershipRecord(): Promise<OwnershipRecord | undefined> {
    await this.initialize();
    return (await readJsonIfPresent(this.ownershipPath, ownershipRecordSchema))?.value;
  }

  public async writeInstanceSecret(secret: string): Promise<void> {
    instanceSecretSchema.parse(secret);
    await this.initialize();
    await writePrivateTextAtomically(this.secretPath, secret);
  }

  public async readInstanceSecret(): Promise<string | undefined> {
    await this.initialize();
    const secret = await readPrivateTextIfPresent(this.secretPath);
    return secret === undefined ? undefined : instanceSecretSchema.parse(secret);
  }

  public async writeManagementSecret(secret: string): Promise<void> {
    instanceSecretSchema.parse(secret);
    await this.initialize();
    await writePrivateTextAtomically(this.managementSecretPath, secret);
  }

  public async readManagementSecret(): Promise<string | undefined> {
    await this.initialize();
    const secret = await readPrivateTextIfPresent(this.managementSecretPath);
    return secret === undefined ? undefined : instanceSecretSchema.parse(secret);
  }

  /**
   * Removes only artifacts still bound to this instance. A replaced ownership
   * record leaves both files untouched, so an old shutdown cannot erase a new
   * gateway's credentials.
   */
  public async removeInstanceArtifacts(expectedInstanceId: string): Promise<boolean> {
    ownershipRecordSchema.shape.instanceId.parse(expectedInstanceId);
    await this.initialize();
    const record = await this.readOwnershipRecord();
    if (!record || record.instanceId !== expectedInstanceId) return false;
    await removePrivateFileIfPresent(this.secretPath);
    await removePrivateFileIfPresent(this.managementSecretPath);
    await removePrivateFileIfPresent(this.ownershipPath);
    return true;
  }

  /**
   * Requires both static ownership/config compatibility and a fresh operating
   * system process-identity observation. This rejects a reused PID.
   */
  public async findReusableOwnership(expected: OwnershipExpectation): Promise<OwnershipRecord | undefined> {
    ownershipExpectationSchema.parse(expected);
    const record = await this.readOwnershipRecord();
    if (!record || !canReuseInstance(record, expected) || !this.#processIdentityLookup) return undefined;
    const observed = await this.#processIdentityLookup(record.pid);
    return matchesProcessIdentity(record, observed) ? record : undefined;
  }

  public async addLease(
    leaseId: string,
    owner: ProcessIdentity,
    attestStaleLock?: StaleLockAttestation,
  ): Promise<OwnershipRecord> {
    ownershipRecordSchema.shape.leases.element.parse(leaseId);
    processIdentitySchema.parse(owner);
    return this.#mutateLeases(owner, attestStaleLock, (record) => {
      if (record.leases.includes(leaseId)) return record;
      return { ...record, leases: [...record.leases, leaseId] };
    });
  }

  /** Idempotent so a replacement launcher can clean up after a crashed lease holder. */
  public async removeLease(
    leaseId: string,
    owner: ProcessIdentity,
    attestStaleLock?: StaleLockAttestation,
  ): Promise<OwnershipRecord> {
    ownershipRecordSchema.shape.leases.element.parse(leaseId);
    processIdentitySchema.parse(owner);
    return this.#mutateLeases(owner, attestStaleLock, (record) => ({
      ...record,
      leases: record.leases.filter((candidate) => candidate !== leaseId),
    }));
  }

  async #mutateLeases(
    owner: ProcessIdentity,
    attestStaleLock: StaleLockAttestation | undefined,
    update: (record: OwnershipRecord) => OwnershipRecord,
  ): Promise<OwnershipRecord> {
    await this.initialize();
    const lock = await this.#acquireLock(this.leaseLockPath, owner, attestStaleLock);
    try {
      const record = await this.readOwnershipRecord();
      if (!record) throw new RuntimeStoreError("cannot update leases without an ownership record");
      const updated = ownershipRecordSchema.parse(update(record));
      await writePrivateJsonAtomically(this.ownershipPath, updated);
      return updated;
    } finally {
      await lock.release();
    }
  }

  async #acquireLock(
    path: string,
    owner: ProcessIdentity,
    attestStaleLock: StaleLockAttestation | undefined,
  ): Promise<RuntimeLock> {
    const lock: StartupLockRecord = {
      lockId: randomUUID(),
      createdAt: new Date().toISOString(),
      owner,
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await open(path, NO_FOLLOW_WRITE_FLAGS, PRIVATE_FILE_MODE);
        try {
          await handle.writeFile(serializeJson(lock));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(path, PRIVATE_FILE_MODE);
        return new RuntimeLock(path, lock);
      } catch (error: unknown) {
        if (!isAlreadyExists(error)) throw error;
      }

      const existing = await readLockIfPresent(path);
      if (!attestStaleLock || !(await attestStaleLock(existing?.value))) {
        throw new StartupLockUnavailableError(`runtime lock is held: ${basename(path)}`);
      }
      if (!existing || !(await unlinkIfUnchanged(path, existing.contentsHash))) {
        continue;
      }
    }
    throw new StartupLockUnavailableError(`runtime lock could not be acquired: ${basename(path)}`);
  }
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function writePrivateJsonAtomically(path: string, value: unknown): Promise<void> {
  await writePrivateTextAtomically(path, serializeJson(value));
}

async function writePrivateTextAtomically(path: string, contents: string): Promise<void> {
  await assertSafeFilePath(path);
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, NO_FOLLOW_WRITE_FLAGS, PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    await chmod(path, PRIVATE_FILE_MODE);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function readPrivateTextIfPresent(path: string): Promise<string | undefined> {
  await assertSafeFilePath(path);
  let handle;
  try {
    handle = await open(path, NO_FOLLOW_READ_FLAGS);
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    await assertSafeOpenFile(handle);
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function readJsonIfPresent<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<{ value: T; contentsHash: string } | undefined> {
  await assertSafeFilePath(path);
  let handle;
  try {
    handle = await open(path, NO_FOLLOW_READ_FLAGS);
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    await assertSafeOpenFile(handle);
    const contents = await handle.readFile({ encoding: "utf8" });
    const value: unknown = JSON.parse(contents) as unknown;
    return { value: schema.parse(value), contentsHash: hash(contents) };
  } finally {
    await handle.close();
  }
}

async function readLockIfPresent(path: string): Promise<{ value: StartupLockRecord | undefined; contentsHash: string } | undefined> {
  await assertSafeFilePath(path);
  let handle;
  try {
    handle = await open(path, NO_FOLLOW_READ_FLAGS);
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    const details = await handle.stat();
    if (details.nlink === 0) return undefined;
    await assertSafeOpenFile(handle);
    const contents = await handle.readFile({ encoding: "utf8" });
    let decoded: unknown;
    try {
      decoded = JSON.parse(contents) as unknown;
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      return { value: undefined, contentsHash: hash(contents) };
    }
    const parsed = startupLockSchema.safeParse(decoded);
    return { value: parsed.success ? parsed.data : undefined, contentsHash: hash(contents) };
  } finally {
    await handle.close();
  }
}

async function assertSafeFilePath(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (!isSafePrivateFile(details)) {
      throw new UnsafeRuntimePathError(`runtime path is not a regular file: ${path}`);
    }
  } catch (error: unknown) {
    if (isNotFound(error)) return;
    throw error;
  }
}

async function assertSafeOpenFile(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  if (!isSafePrivateFile(await handle.stat())) {
    throw new UnsafeRuntimePathError("runtime file changed to an unsafe file while opening");
  }
}

function isSafePrivateFile(details: Stats): boolean {
  return details.isFile()
    && details.nlink === 1
    && details.uid === currentUid()
    && fileMode(details.mode) === PRIVATE_FILE_MODE;
}

async function removePrivateFileIfPresent(path: string): Promise<void> {
  await assertSafeFilePath(path);
  await unlink(path).catch((error: unknown) => {
    if (isNotFound(error)) return;
    throw error;
  });
}

async function unlinkIfUnchanged(path: string, expectedHash: string): Promise<boolean> {
  const current = await readJsonIfPresent(path, z.unknown());
  if (!current || current.contentsHash !== expectedHash) return false;
  await unlink(path).catch((error: unknown) => {
    if (isNotFound(error)) return;
    throw error;
  });
  return true;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function currentUid(): number {
  const getuid = process.getuid;
  if (!getuid) throw new RuntimeStoreError("runtime ownership checks require a POSIX uid");
  return getuid.call(process);
}

function fileMode(mode: number): number {
  return mode & 0o777;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
