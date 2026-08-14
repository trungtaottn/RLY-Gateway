import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  recoverUpdateState,
  UpdateLockUnavailableError,
  UpdateStateError,
  UpdateStateStore,
} from "../../src/runtime/update/store.js";
import { UPDATE_LOCK_FILE_NAME, UPDATE_STATE_FILE_NAME, type UpdateStateRecord } from "../../src/runtime/update/types.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-gateway-update-state-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function record(state: UpdateStateRecord["state"], overrides: Partial<UpdateStateRecord> = {}): UpdateStateRecord {
  return {
    schemaVersion: 1,
    state,
    currentVersion: "0.1.0",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("update state store (#73)", () => {
  it("persists durable states and reads them back (private 0600 file)", async () => {
    const dir = await directory();
    const store = new UpdateStateStore(dir);
    expect(await store.read()).toBeUndefined();
    await store.write(record("pending-activation", { pendingVersion: "2.0.0", previousVersion: "0.1.0" }));
    const read = await store.read();
    expect(read?.state).toBe("pending-activation");
    expect(read?.pendingVersion).toBe("2.0.0");
    const details = await stat(join(dir, UPDATE_STATE_FILE_NAME));
    expect(details.mode & 0o777).toBe(0o600);
    expect(details.uid).toBe(process.getuid?.());
    const contents = await readFile(join(dir, UPDATE_STATE_FILE_NAME), "utf8");
    expect(contents).not.toMatch(/secret|token|Bearer|@|prompt|response/i);
  });

  it("enforces CAS transitions from the expected states only", async () => {
    const dir = await directory();
    const store = new UpdateStateStore(dir);
    await store.transition([], (current) => record("installing", { currentVersion: current?.currentVersion ?? "0.1.0", pendingVersion: "2.0.0" }));
    const pending = await store.transition(["installing"], (current) => ({
      ...(current ?? record("installing")),
      state: "pending-activation" as const,
      pendingVersion: "2.0.0",
      updatedAt: new Date().toISOString(),
    }));
    expect(pending.state).toBe("pending-activation");
    await expect(store.transition(["installing"], (current) => ({ ...(current ?? pending), state: "active" as const })))
      .rejects.toThrow(UpdateStateError);
  });

  it("serializes concurrent transitions through the update lock", async () => {
    const dir = await directory();
    const store = new UpdateStateStore(dir);
    await store.write(record("pending-activation", { pendingVersion: "2.0.0" }));
    const first = await store.acquireLock();
    // A second update in the same process cannot acquire the live lock.
    await expect(store.acquireLock()).rejects.toThrow(UpdateLockUnavailableError);
    await first.release();
    const second = await store.acquireLock();
    await second.release();
  });

  it("reclaims a stale lock whose owner process is gone", async () => {
    const dir = await directory();
    const store = new UpdateStateStore(dir, (pid) => {
      // The dead owner pid is never observed by the OS process table.
      return pid === 999_999 ? undefined : { processStartedAt: new Date().toISOString() };
    });
    await store.write(record("pending-activation", { pendingVersion: "2.0.0" }));
    const stale = await store.acquireLock();
    await stale.release();
    // Simulate a crashed updater: write a lock owned by a dead process.
    const { writePrivateTextAtomically } = await import("../../src/storage/private-files.js");
    await writePrivateTextAtomically(join(dir, UPDATE_LOCK_FILE_NAME), `${JSON.stringify({
      lockId: "00000000-0000-4000-8000-000000000073",
      createdAt: "2026-08-13T00:00:00.000Z",
      owner: { pid: 999_999, processStartedAt: "2020-01-01T00:00:00.000Z" },
    })}\n`);
    // Dead owner (lookup returns nothing) ⇒ reclaimed.
    const reclaimed = await store.acquireLock();
    await reclaimed.release();
  });

  it("fails closed on a malformed state file instead of trusting it", async () => {
    const dir = await directory();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, UPDATE_STATE_FILE_NAME), "not json", { mode: 0o600 });
    const store = new UpdateStateStore(dir);
    await expect(store.read()).rejects.toThrow();
  });

  it("recovers crash states deterministically", () => {
    expect(recoverUpdateState(undefined)).toBeUndefined();
    expect(recoverUpdateState(record("idle"))?.state).toBe("idle");
    expect(recoverUpdateState(record("active"))?.state).toBe("active");
    const installing = recoverUpdateState(record("installing", { pendingVersion: "2.0.0" }));
    expect(installing?.state).toBe("failed");
    expect(installing?.failureReason).toContain("interrupted");
    const pending = recoverUpdateState(record("pending-activation", { pendingVersion: "2.0.0", previousVersion: "0.1.0" }));
    expect(pending?.state).toBe("pending-activation");
    expect(pending?.pendingVersion).toBe("2.0.0");
    const activating = recoverUpdateState(record("activating", { pendingVersion: "2.0.0", previousVersion: "0.1.0" }));
    expect(activating?.state).toBe("rollback-required");
    expect(activating?.failureReason).toContain("rollback");
    // Activation without a rollback reference cannot roll back safely.
    const orphaned = recoverUpdateState(record("activating", { pendingVersion: "2.0.0" }));
    expect(orphaned?.state).toBe("failed");
    expect(orphaned?.failureReason).toContain("rollback reference");
    // Pending activation without a candidate reference is unrecoverable.
    const lost = recoverUpdateState(record("pending-activation"));
    expect(lost?.state).toBe("failed");
  });
});
