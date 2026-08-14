import { chmod, link, mkdtemp, lstat, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RuntimeStore,
  StartupLockUnavailableError,
  UnsafeRuntimePathError,
} from "../../src/runtime/runtime-store.js";
import type { OwnershipRecord, ProcessIdentity } from "../../src/runtime/ownership-record.js";
import type { RuntimeLock } from "../../src/runtime/runtime-store.js";

const owner: ProcessIdentity = { pid: 4321, processStartedAt: "2026-08-13T00:00:00.000Z" };
const leaseOne = "00000000-0000-4000-8000-000000000011";
const leaseTwo = "00000000-0000-4000-8000-000000000012";
const directories: string[] = [];

async function makeStore(identity: ProcessIdentity | undefined = owner): Promise<RuntimeStore> {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-runtime-"));
  directories.push(directory);
  return new RuntimeStore(directory, { processIdentityLookup: () => identity });
}

function record(overrides: Partial<OwnershipRecord> = {}): OwnershipRecord {
  return {
    pid: owner.pid,
    processStartedAt: owner.processStartedAt,
    instanceId: "00000000-0000-4000-8000-000000000001",
    port: 17871,
    executableFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    nonceHash: "c".repeat(64),
    ownerLauncherPid: 4300,
    leases: [],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("runtime store", () => {
  it("atomically permits only one concurrent startup lock holder", async () => {
    const store = await makeStore();
    const results = await Promise.allSettled([
      store.acquireStartupLock(owner),
      store.acquireStartupLock(owner),
    ]);
    const acquired = results.filter((result): result is PromiseFulfilledResult<RuntimeLock> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(StartupLockUnavailableError);
    const acquiredLock = acquired[0];
    if (!acquiredLock) throw new Error("expected exactly one acquired startup lock");
    await acquiredLock.value.release();
  });

  it("refuses symlink replacement of ownership files", async () => {
    const store = await makeStore();
    const target = join(store.directory, "outside.json");
    await writeFile(target, "{}", "utf8");
    await symlink(target, store.ownershipPath);
    await expect(store.writeOwnershipRecord(record())).rejects.toBeInstanceOf(UnsafeRuntimePathError);
    await expect(store.readOwnershipRecord()).rejects.toBeInstanceOf(UnsafeRuntimePathError);
  });

  it("refuses a symlinked instance secret", async () => {
    const store = await makeStore();
    const target = join(store.directory, "outside.secret");
    await writeFile(target, "other-secret", { mode: 0o600 });
    await symlink(target, store.secretPath);
    await expect(store.writeInstanceSecret("gateway-secret")).rejects.toBeInstanceOf(UnsafeRuntimePathError);
    await expect(store.readInstanceSecret()).rejects.toBeInstanceOf(UnsafeRuntimePathError);
  });

  it("uses restrictive directory and record modes", async () => {
    const store = await makeStore();
    await store.writeOwnershipRecord(record());
    await store.writeInstanceSecret("gateway-secret");
    expect((await lstat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(store.ownershipPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(store.secretPath)).mode & 0o777).toBe(0o600);
  });

  it("refuses pre-existing runtime files with an unsafe mode", async () => {
    const store = await makeStore();
    await writeFile(store.secretPath, "gateway-secret", { mode: 0o600 });
    await chmod(store.secretPath, 0o644);
    await expect(store.readInstanceSecret()).rejects.toBeInstanceOf(UnsafeRuntimePathError);
    await expect(store.writeInstanceSecret("replacement")).rejects.toBeInstanceOf(UnsafeRuntimePathError);
  });

  it("refuses hard-linked instance secrets", async () => {
    const store = await makeStore();
    const secondLink = join(store.directory, "second.secret");
    await writeFile(store.secretPath, "gateway-secret", { mode: 0o600 });
    await link(store.secretPath, secondLink);
    await expect(store.readInstanceSecret()).rejects.toBeInstanceOf(UnsafeRuntimePathError);
  });

  it("refuses an existing runtime directory with a non-private mode", async () => {
    const store = await makeStore();
    await chmod(store.directory, 0o755);
    await expect(store.initialize()).rejects.toBeInstanceOf(UnsafeRuntimePathError);
  });

  it("persists and removes secret artifacts only for the matching instance", async () => {
    const store = await makeStore();
    const first = record();
    await store.writeOwnershipRecord(first);
    await store.writeInstanceSecret("gateway-secret");
    await expect(store.readInstanceSecret()).resolves.toBe("gateway-secret");
    await expect(store.removeInstanceArtifacts("00000000-0000-4000-8000-000000000002")).resolves.toBe(false);
    await expect(store.readOwnershipRecord()).resolves.toEqual(first);
    await expect(store.readInstanceSecret()).resolves.toBe("gateway-secret");
    await expect(store.removeInstanceArtifacts(first.instanceId)).resolves.toBe(true);
    await expect(store.readOwnershipRecord()).resolves.toBeUndefined();
    await expect(store.readInstanceSecret()).resolves.toBeUndefined();
  });

  it("requires matching process identity and config evidence to reuse", async () => {
    const store = await makeStore(owner);
    const saved = record();
    await store.writeOwnershipRecord(saved);
    await expect(store.findReusableOwnership(saved)).resolves.toEqual(saved);
    await expect(store.findReusableOwnership({ ...saved, configFingerprint: "d".repeat(64) })).resolves.toBeUndefined();

    const reusedPidStore = new RuntimeStore(store.directory, {
      processIdentityLookup: () => ({ ...owner, processStartedAt: "2026-08-13T00:00:02.000Z" }),
    });
    await expect(reusedPidStore.findReusableOwnership(saved)).resolves.toBeUndefined();

    const stalePidStore = new RuntimeStore(store.directory, { processIdentityLookup: () => undefined });
    await expect(stalePidStore.findReusableOwnership(saved)).resolves.toBeUndefined();
  });

  it("atomically adds and removes leases after a crashed holder", async () => {
    const store = await makeStore();
    await store.writeOwnershipRecord(record({ leases: [leaseOne] }));
    await expect(store.removeLease(leaseOne, owner)).resolves.toMatchObject({ leases: [] });
    await expect(store.addLease(leaseTwo, owner)).resolves.toMatchObject({ leases: [leaseTwo] });
    await expect(readFile(store.ownershipPath, "utf8")).resolves.toContain(leaseTwo);
  });

  it("requires callers to serialize concurrent lease writers", async () => {
    const store = await makeStore();
    await store.writeOwnershipRecord(record());
    const first = await store.acquireStartupLock(owner);
    await expect(store.acquireStartupLock(owner)).rejects.toBeInstanceOf(StartupLockUnavailableError);
    await first.release();
  });

  it("cleans a stale lease mutation lock only after explicit attestation", async () => {
    const store = await makeStore();
    await store.writeOwnershipRecord(record());
    await writeFile(store.leaseLockPath, JSON.stringify({
      lockId: "00000000-0000-4000-8000-000000000099",
      createdAt: "2026-08-13T00:00:00.000Z",
      owner,
    }), { mode: 0o600 });
    await expect(store.addLease(leaseOne, owner)).rejects.toBeInstanceOf(StartupLockUnavailableError);
    await expect(store.addLease(leaseOne, owner, () => true)).resolves.toMatchObject({ leases: [leaseOne] });
  });
});
