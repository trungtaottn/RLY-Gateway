import { randomUUID } from "node:crypto";
import { matchesProcessIdentity, type ProcessIdentity } from "../runtime/ownership-record.js";
import { readProcessIdentity } from "../runtime/process-identity.js";
import {
  createExclusivePrivateFile,
  readPrivateTextIfPresent,
  removePrivateFileIfPresent,
} from "./private-files.js";

export type OwnershipLockPayload = Readonly<{
  lockId: string;
  createdAt: string;
  owner: ProcessIdentity;
  resource?: string;
}>;

export class OwnershipLockError extends Error {
  override name = "OwnershipLockError";
}

export type OwnershipLock = Readonly<{
  release: () => Promise<void>;
}>;

export async function acquireOwnershipLock(
  path: string,
  options: Readonly<{
    resource?: string;
    attempts?: number;
    waitMs?: number;
    onLive?: "wait" | "reject";
    identityError?: () => Error;
    liveError?: () => Error;
  }> = {},
): Promise<OwnershipLock> {
  const owner = await readProcessIdentity(process.pid);
  if (!owner) {
    throw options.identityError?.() ?? new OwnershipLockError("unable to read process identity for lock");
  }
  const lockId = randomUUID();
  const payload: OwnershipLockPayload = {
    lockId,
    createdAt: new Date().toISOString(),
    owner,
    ...(options.resource === undefined ? {} : { resource: options.resource }),
  };
  const serialized = `${JSON.stringify(payload)}\n`;
  const attempts = options.attempts ?? 1;
  const waitMs = options.waitMs ?? 0;
  const onLive = options.onLive ?? "reject";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await createExclusivePrivateFile(path, serialized)) {
      return {
        release: async () => {
          const current = await readPrivateTextIfPresent(path);
          if (current !== undefined && lockIdFrom(current) === lockId) {
            await removePrivateFileIfPresent(path);
          }
        },
      };
    }
    const existing = await readPrivateTextIfPresent(path);
    if (existing !== undefined && await isStaleOwnershipLock(existing)) {
      const still = await readPrivateTextIfPresent(path);
      if (still === existing) await removePrivateFileIfPresent(path);
      continue;
    }
    if (onLive === "reject") {
      throw options.liveError?.() ?? new OwnershipLockError("lock is held");
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw options.liveError?.() ?? new OwnershipLockError("lock is held");
}

export async function isStaleOwnershipLock(raw: string): Promise<boolean> {
  try {
    const lock = JSON.parse(raw) as Partial<OwnershipLockPayload> & { owner?: Partial<ProcessIdentity> };
    if (typeof lock.owner?.pid !== "number" || typeof lock.owner.processStartedAt !== "string") return true;
    const observed = await readProcessIdentity(lock.owner.pid);
    return !matchesProcessIdentity({
      pid: lock.owner.pid,
      processStartedAt: lock.owner.processStartedAt,
    }, observed);
  } catch {
    return true;
  }
}

export function lockIdFrom(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { lockId?: unknown };
    return typeof parsed.lockId === "string" ? parsed.lockId : undefined;
  } catch {
    return undefined;
  }
}

export async function reclaimStaleLockFile(path: string): Promise<boolean> {
  const existing = await readPrivateTextIfPresent(path);
  if (existing === undefined) return false;
  if (!(await isStaleOwnershipLock(existing))) return false;
  const still = await readPrivateTextIfPresent(path);
  if (still !== existing) return false;
  await removePrivateFileIfPresent(path);
  return true;
}
