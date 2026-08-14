import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ensurePrivateDirectory,
  fileMode,
  fsyncPrivateDirectory,
  listPrivateDirectory,
  PRIVATE_DIRECTORY_MODE,
  readPrivateTextIfPresent,
  removePrivateFileIfPresent,
  writePrivateTextAtomically,
} from "../storage/private-files.js";
import { acquireOwnershipLock, reclaimStaleLockFile } from "../storage/ownership-lock.js";
import { controlPlanePaths } from "../storage/paths.js";
import { lstat } from "node:fs/promises";
import { CredentialError, CredentialUnreadyError, StaleGenerationError } from "./errors.js";
import {
  parseCredentialRecord,
  toCredentialMetadata,
  type CredentialMetadata,
  type CredentialRecord,
} from "./record.js";

export class CredentialStore {
  private constructor(readonly directory: string) {}

  public static async open(controlPlaneDirectory: string): Promise<CredentialStore> {
    const paths = controlPlanePaths(controlPlaneDirectory);
    await ensurePrivateDirectory(paths.directory);
    await ensurePrivateDirectory(paths.credentials);
    await ensurePrivateDirectory(paths.credentialQuarantine);
    await ensurePrivateDirectory(paths.credentialLocks);
    const store = new CredentialStore(controlPlaneDirectory);
    await store.recoverAll();
    return store;
  }

  public paths(): ReturnType<typeof controlPlanePaths> {
    return controlPlanePaths(this.directory);
  }

  public async read(handle: string): Promise<CredentialRecord> {
    await this.assertSafeStore();
    const current = await this.readActiveOrBackup(handle);
    if (!current) throw new CredentialUnreadyError();
    return current;
  }

  public async metadata(handle: string): Promise<CredentialMetadata | undefined> {
    try {
      return toCredentialMetadata(await this.read(handle));
    } catch (error) {
      if (error instanceof CredentialUnreadyError) return undefined;
      throw error;
    }
  }

  public async commit(handle: string, expectedGeneration: number, next: CredentialRecord): Promise<CredentialRecord> {
    if (next.handle !== handle) throw new CredentialError("handle mismatch", 400, "invalid");
    if (next.generation !== expectedGeneration + 1) throw new StaleGenerationError();
    return this.withLock(handle, async () => {
      const current = await this.readActiveOrBackup(handle);
      if (current && current.generation !== expectedGeneration) throw new StaleGenerationError();
      if (!current && expectedGeneration !== 0) throw new StaleGenerationError();
      await this.replace(handle, next);
      return next;
    });
  }

  public async purge(handle: string): Promise<void> {
    await this.withLock(handle, async () => {
      const paths = this.filePaths(handle);
      await removePrivateFileIfPresent(paths.active);
      await removePrivateFileIfPresent(paths.backup);
      await this.removeTemporary(handle);
      await this.removeQuarantine(handle);
      await fsyncPrivateDirectory(this.paths().credentials);
    });
  }

  private async listedHandles(): Promise<Set<string>> {
    await this.assertSafeStore();
    const names = await listPrivateDirectory(this.paths().credentials);
    return new Set(names.flatMap((name) => handleFromFileName(name) ?? []));
  }

  public async recoverAll(): Promise<void> {
    for (const handle of await this.listedHandles()) await this.recover(handle);
    await this.reclaimStaleLocks();
  }

  public async listHandles(): Promise<string[]> {
    return [...await this.listedHandles()];
  }

  private async recover(handle: string): Promise<CredentialRecord | undefined> {
    await this.removeTemporary(handle);
    const paths = this.filePaths(handle);
    const active = await this.parseFile(paths.active);
    if (active) {
      await removePrivateFileIfPresent(paths.backup);
      return active;
    }
    const backup = await this.parseFile(paths.backup);
    if (backup) {
      await writePrivateTextAtomically(paths.active, serializeRecord(backup));
      await removePrivateFileIfPresent(paths.backup);
      await fsyncPrivateDirectory(this.paths().credentials);
      return backup;
    }
    await this.quarantineIfPresent(paths.active);
    await this.quarantineIfPresent(paths.backup);
    return undefined;
  }

  private async replace(handle: string, next: CredentialRecord): Promise<void> {
    const paths = this.filePaths(handle);
    const active = await readPrivateTextIfPresent(paths.active);
    if (active !== undefined) await writePrivateTextAtomically(paths.backup, active);
    await writePrivateTextAtomically(paths.active, serializeRecord(next));
    const verified = await this.parseFile(paths.active);
    if (!verified || verified.generation !== next.generation) {
      throw new CredentialError("credential commit could not be verified", 500, "commit-failed");
    }
    await removePrivateFileIfPresent(paths.backup);
    await fsyncPrivateDirectory(this.paths().credentials);
  }

  private async readActiveOrBackup(handle: string): Promise<CredentialRecord | undefined> {
    return await this.parseFile(this.filePaths(handle).active) ?? await this.parseFile(this.filePaths(handle).backup);
  }

  private async parseFile(path: string): Promise<CredentialRecord | undefined> {
    const raw = await readPrivateTextIfPresent(path);
    if (raw === undefined) return undefined;
    try {
      return parseCredentialRecord(JSON.parse(raw) as unknown);
    } catch {
      return undefined;
    }
  }

  private async quarantineIfPresent(path: string): Promise<void> {
    const raw = await readPrivateTextIfPresent(path);
    if (raw === undefined) return;
    const destination = join(this.paths().credentialQuarantine, `${basenameSafe(path)}.${randomUUID()}`);
    await writePrivateTextAtomically(destination, raw);
    await removePrivateFileIfPresent(path);
    await fsyncPrivateDirectory(this.paths().credentialQuarantine);
    await fsyncPrivateDirectory(this.paths().credentials);
  }

  private async removeTemporary(handle: string): Promise<void> {
    await this.removeMatching(
      this.paths().credentials,
      (name) => name.startsWith(`.${handle}.`) && name.endsWith(".tmp"),
    );
  }

  private async removeQuarantine(handle: string): Promise<void> {
    await this.removeMatching(
      this.paths().credentialQuarantine,
      (name) => name.startsWith(`${handle}.`),
    );
  }

  private async removeMatching(directory: string, match: (name: string) => boolean): Promise<void> {
    const names = await listPrivateDirectory(directory);
    for (const name of names) {
      if (match(name)) await removePrivateFileIfPresent(join(directory, name));
    }
  }

  private async withLock<T>(handle: string, work: () => Promise<T>): Promise<T> {
    const lockPath = join(this.paths().credentialLocks, `${handle}.lock`);
    const lock = await acquireOwnershipLock(lockPath, {
      resource: handle,
      attempts: 8,
      waitMs: 0,
      onLive: "reject",
      identityError: () => new CredentialError("unable to read process identity for credential lock", 500, "lock-identity"),
      liveError: () => new CredentialError("credential is locked", 409, "locked"),
    });
    try {
      return await work();
    } finally {
      await lock.release();
    }
  }

  private async reclaimStaleLocks(): Promise<void> {
    const names = await listPrivateDirectory(this.paths().credentialLocks);
    for (const name of names) {
      if (!name.endsWith(".lock")) continue;
      await reclaimStaleLockFile(join(this.paths().credentialLocks, name));
    }
  }

  private filePaths(handle: string): Readonly<{ active: string; backup: string }> {
    const root = this.paths().credentials;
    return { active: join(root, `${handle}.json`), backup: join(root, `${handle}.bak`) };
  }

  private async assertSafeStore(): Promise<void> {
    const details = await lstat(this.paths().credentials);
    if (!details.isDirectory() || details.isSymbolicLink() || fileMode(details.mode) !== PRIVATE_DIRECTORY_MODE) {
      throw new CredentialError("credential directory is unsafe", 500, "unsafe-store");
    }
  }
}

function serializeRecord(record: CredentialRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function handleFromFileName(name: string): string | undefined {
  const match = /^(cred-[A-Za-z0-9_-]+)\.(json|bak)$/.exec(name);
  return match?.[1];
}

function basenameSafe(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

