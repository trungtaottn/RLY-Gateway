import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CAPABILITIES, createReadyPool, createSelector, openStore, readySnapshots, tempDir } from "./helpers.js";

const directories: string[] = [];
const now = new Date("2026-08-13T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("selector restart", () => {
  it("preserves durable pause and cooldown and resets ephemeral round-robin state", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { accounts, pool } = createReadyPool(store, {
      strategy: "round-robin",
      specs: [
        { pseudonym: "acct-fixture-001", handle: "cred-001" },
        { pseudonym: "acct-fixture-002", handle: "cred-002" },
      ],
    });
    const first = accounts[0];
    if (!first) throw new Error("expected account");
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    const snapshots = readySnapshots(accounts);
    await selector.select({
      requestId: "req-before",
      poolId: pool.id,
      policy,
      required: [],
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: snapshots,
    });
    expect(selector.cursorFor(pool.id)).toBe(1);
    store.updateAccount(first.id, store.getAccount(first.id).version, { state: "paused", pauseReason: "owner" }, "cli");
    store.recordRouteOutcome(accounts[1]?.id ?? first.id, {
      outcome: "quota",
      quotaClass: "exhausted",
      cooldownUntil: "2026-08-13T01:00:00.000Z",
    });
    store.close();

    const restarted = await openStore(directory, now);
    const fresh = createSelector(restarted, now);
    expect(fresh.cursorFor(pool.id)).toBe(0);
    expect(restarted.getAccount(first.id).state).toBe("paused");
    const cooled = restarted.listAccounts().find((account) => account.pseudonym === "acct-fixture-002");
    expect(cooled?.cooldownUntil).toBe("2026-08-13T01:00:00.000Z");
    const nextPolicy = restarted.currentPolicy();
    if (!nextPolicy) throw new Error("expected policy");
    await expect(fresh.select({
      requestId: "req-after",
      poolId: pool.id,
      policy: nextPolicy,
      required: [],
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: readySnapshots(restarted.listAccounts()),
    })).rejects.toThrow("No eligible account");
    restarted.close();
  });
});
