import { constants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const INSTALLATION_FILE_NAME = "installation.json";

const installationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().min(1),
  configPath: z.string().min(1),
  platform: z.enum(["darwin", "linux", "unsupported"]),
  serviceName: z.string().min(1),
  registeredAt: z.iso.datetime(),
});

export type InstallationRecord = z.infer<typeof installationRecordSchema>;

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

/**
 * Writes the secret-free user-installation record atomically inside the
 * durable control-plane home (~/.rly by default). Refuses links and keeps the
 * file at 0600 like every other project-owned artifact.
 */
export async function writeInstallation(directory: string, record: InstallationRecord): Promise<void> {
  installationRecordSchema.parse(record);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const path = join(directory, INSTALLATION_FILE_NAME);
  await writePrivateTextAtomically(path, `${JSON.stringify(record)}\n`);
}

export async function readInstallation(directory: string): Promise<InstallationRecord | undefined> {
  const path = join(directory, INSTALLATION_FILE_NAME);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    return undefined;
  }
  try {
    const contents = await handle.readFile({ encoding: "utf8" });
    return installationRecordSchema.parse(JSON.parse(contents) as unknown);
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function writePrivateTextAtomically(path: string, contents: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${INSTALLATION_FILE_NAME}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined);
    if (isAlreadyExists(error)) throw error;
    throw error;
  }
}
