import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, rename, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW_WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const NO_FOLLOW_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

export class UnsafePrivatePathError extends Error {
  override name = "UnsafePrivatePathError";
}

export function currentUid(): number {
  const getuid = process.getuid;
  if (!getuid) throw new UnsafePrivatePathError("private path checks require a POSIX uid");
  return getuid.call(process);
}

export function fileMode(mode: number): number {
  return mode & 0o777;
}

export function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  let created = false;
  try {
    await lstat(directory);
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    created = true;
  }
  let details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== currentUid()) {
    throw new UnsafePrivatePathError(`path is not a current-user private directory: ${directory}`);
  }
  if (created) {
    await chmod(directory, PRIVATE_DIRECTORY_MODE);
    details = await lstat(directory);
  }
  if (fileMode(details.mode) !== PRIVATE_DIRECTORY_MODE) {
    throw new UnsafePrivatePathError(`directory must use mode 0700: ${directory}`);
  }
}

export async function writePrivateTextAtomically(path: string, contents: string): Promise<void> {
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

export async function readPrivateTextIfPresent(path: string): Promise<string | undefined> {
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

export async function removePrivateFileIfPresent(path: string): Promise<void> {
  await assertSafeFilePath(path);
  await unlink(path).catch((error: unknown) => {
    if (isNotFound(error)) return;
    throw error;
  });
}

export async function createExclusivePrivateFile(path: string, contents: string): Promise<boolean> {
  await assertSafeFilePath(path);
  try {
    const handle = await open(path, NO_FOLLOW_WRITE_FLAGS, PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, PRIVATE_FILE_MODE);
    return true;
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) throw error;
    return false;
  }
}

export async function chmodPrivateFile(path: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 || details.uid !== currentUid()) {
    throw new UnsafePrivatePathError(`cannot restrict an unsafe file: ${path}`);
  }
  await chmod(path, PRIVATE_FILE_MODE);
}

export async function fsyncPrivateDirectory(directory: string): Promise<void> {
  await ensurePrivateDirectory(directory);
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Reads the target of a private reference symlink (refs under the durable
 * state root). Missing ⇒ undefined; a present entry that is not a current-user
 * symlink fails closed. Symlinks are the only link type the runtime store
 * intentionally owns (deployment references); every file write elsewhere
 * still refuses links.
 */
export async function readPrivateSymlinkTarget(path: string): Promise<string | undefined> {
  let details: Stats;
  try {
    details = await lstat(path);
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (!details.isSymbolicLink()) {
    throw new UnsafePrivatePathError(`refusing a non-symlink reference: ${path}`);
  }
  if (details.uid !== currentUid()) {
    throw new UnsafePrivatePathError(`reference is not owned by the current user: ${path}`);
  }
  return readlink(path);
}

/**
 * Removes a private reference symlink when present. A present entry that is
 * not a current-user symlink fails closed (never unlink a non-symlink).
 */
export async function removePrivateSymlinkIfPresent(path: string): Promise<void> {
  let details: Stats;
  try {
    details = await lstat(path);
  } catch (error: unknown) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (!details.isSymbolicLink()) {
    throw new UnsafePrivatePathError(`refusing to remove a non-symlink reference: ${path}`);
  }
  if (details.uid !== currentUid()) {
    throw new UnsafePrivatePathError(`reference is not owned by the current user: ${path}`);
  }
  await unlink(path);
}

/**
 * Atomically replaces (or creates) a reference symlink. The replacement is a
 * temp-reference create + atomic rename (+ parent-directory fsync), never a
 * `rm + symlink` pair, so a concurrent reader observes either the previous
 * valid reference or the new valid reference, never an intentional missing
 * intermediate state. Stale temp references left by an interrupted replace
 * (crash between temp creation and rename) are cleaned on the next replace.
 */
export async function replacePrivateSymlinkAtomically(path: string, target: string): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  await removeStalePrivateSymlinkTemps(directory, basename(path));
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  await symlink(target, temporaryPath);
  try {
    const details = await lstat(temporaryPath);
    if (!details.isSymbolicLink() || details.uid !== currentUid()) {
      throw new UnsafePrivatePathError(`refused unsafe reference symlink: ${temporaryPath}`);
    }
    await rename(temporaryPath, path);
    await fsyncPrivateDirectory(directory);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function removeStalePrivateSymlinkTemps(directory: string, base: string): Promise<void> {
  const names = await readdir(directory).catch((error: unknown) => {
    if (isNotFound(error)) return [];
    throw error;
  });
  const prefix = `.${base}.`;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const temporaryPath = join(directory, name);
    const details = await lstat(temporaryPath).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (details === undefined) continue;
    if (!details.isSymbolicLink()) {
      throw new UnsafePrivatePathError(`refusing an unsafe stale reference temp: ${temporaryPath}`);
    }
    if (details.uid !== currentUid()) {
      throw new UnsafePrivatePathError(`stale reference temp is not owned by the current user: ${temporaryPath}`);
    }
    await unlink(temporaryPath);
  }
}

export async function listPrivateDirectory(directory: string): Promise<string[]> {
  await ensurePrivateDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink()).map((entry) => entry.name);
}

export async function renamePrivateFile(from: string, to: string): Promise<void> {
  await assertSafeFilePath(from);
  await assertSafeFilePath(to);
  await rename(from, to);
  await chmodPrivateFile(to);
}

async function assertSafeFilePath(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (!isSafePrivateFile(details) && !details.isDirectory()) {
      throw new UnsafePrivatePathError(`path is not a regular file: ${path}`);
    }
  } catch (error: unknown) {
    if (isNotFound(error)) return;
    throw error;
  }
}

async function assertSafeOpenFile(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  if (!isSafePrivateFile(await handle.stat())) {
    throw new UnsafePrivatePathError("file changed to an unsafe file while opening");
  }
}

function isSafePrivateFile(details: Stats): boolean {
  return details.isFile()
    && details.nlink === 1
    && details.uid === currentUid()
    && fileMode(details.mode) === PRIVATE_FILE_MODE;
}
