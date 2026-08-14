import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CredentialUnreadyError, ImportIncompatibleError } from "../../credentials/errors.js";
import {
  readPrivateTextIfPresent,
  removePrivateFileIfPresent,
  writePrivateTextAtomically,
} from "../../storage/private-files.js";

export const CLINE_ADAPTER_ID = "cline-interop";
export const CLINE_INTEROP_LOCK = "cline.lock";
export const CLINE_INTEROP_BACKUP = "cline.source.bak";

export type ClineImportPreview = Readonly<{
  schema: "cline-oauth-v1";
  provider: "cline";
  sourceFingerprint: string;
  expiresAt: string | undefined;
}>;

export type ClineSourceRead = Readonly<{
  preview: ClineImportPreview;
  tokens: Readonly<{ accessToken: string; refreshToken: string; expiresAt?: string }>;
}>;

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

const sourceSchema = {
  parse(value: unknown): { access: string; refresh: string; expiresAt?: string } {
    const material = asObject(asObject(value)?.tokens);
    const access = typeof material?.access_token === "string" ? material.access_token : "";
    const refresh = typeof material?.refresh_token === "string" ? material.refresh_token : "";
    if (!material || !access || !refresh) throw new ImportIncompatibleError("cline source schema is unsupported");
    return {
      access,
      refresh,
      ...(typeof material.expires_at === "string" ? { expiresAt: material.expires_at } : {}),
    };
  },
};

export async function previewClineSource(sourcePath: string): Promise<ClineImportPreview> {
  return (await readClineSource(sourcePath)).preview;
}

export async function readClineSource(sourcePath: string): Promise<ClineSourceRead> {
  if (!sourcePath || basename(sourcePath) === "") throw new ImportIncompatibleError("cline source path is required");
  const first = await digestClineFile(sourcePath);
  const parsed = sourceSchema.parse(JSON.parse(first.contents) as unknown);
  const second = await digestClineFile(sourcePath);
  if (second.fingerprint !== first.fingerprint) throw new ImportIncompatibleError("cline source changed during import");
  return {
    preview: {
      schema: "cline-oauth-v1",
      provider: "cline",
      sourceFingerprint: first.fingerprint,
      expiresAt: parsed.expiresAt,
    },
    tokens: {
      accessToken: parsed.access,
      refreshToken: parsed.refresh,
      ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt }),
    },
  };
}

async function digestClineFile(path: string): Promise<{ fingerprint: string; contents: string }> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > 64 * 1024) {
    throw new ImportIncompatibleError("cline source is unreadable or oversized");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const contents = await handle.readFile("utf8");
    return { fingerprint: createHash("sha256").update(contents).digest("hex"), contents };
  } finally {
    await handle.close();
  }
}

export async function lockClineInterop(directory: string, sourcePath: string): Promise<void> {
  const existing = await readPrivateTextIfPresent(join(directory, CLINE_INTEROP_LOCK));
  if (existing) throw new CredentialUnreadyError("cline interoperability lock is already held");
  await writePrivateTextAtomically(join(directory, CLINE_INTEROP_LOCK), JSON.stringify({
    sourcePath,
    lockedAt: new Date().toISOString(),
  }));
}

export async function backupClineSource(directory: string, sourcePath: string): Promise<string> {
  const raw = await readFile(sourcePath, "utf8");
  const backup = join(directory, CLINE_INTEROP_BACKUP);
  await writePrivateTextAtomically(backup, raw);
  return backup;
}

export async function restoreClineSource(directory: string, sourcePath: string): Promise<void> {
  const backup = await readPrivateTextIfPresent(join(directory, CLINE_INTEROP_BACKUP));
  if (!backup) throw new CredentialUnreadyError("cline interoperability backup is missing");
  await writeFile(sourcePath, backup, { encoding: "utf8", mode: 0o600 });
}

export async function unlockClineInterop(directory: string): Promise<void> {
  await removePrivateFileIfPresent(join(directory, CLINE_INTEROP_LOCK));
}

export function rejectSilentClineDiscovery(requestedPath: string | undefined): void {
  if (!requestedPath) throw new ImportIncompatibleError("cline import requires an explicit source path");
  void dirname(requestedPath);
}
