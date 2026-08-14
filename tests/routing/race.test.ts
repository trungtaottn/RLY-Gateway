import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CAPABILITIES, createReadyPool, createSelector, openStore, readySnapshots, tempDir } from "./helpers.js";

const directories: string[] = [];
const now = new Date("2026-08-13T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("pool isolation", () => {
  it("keeps concurrent selections from contaminating route or cursor state", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { pool } = createReadyPool(store, {
      strategy: "round-robin",
      specs: [
        { pseudonym: "acct-fixture-001", handle: "cred-001" },
        { pseudonym: "acct-fixture-002", handle: "cred-002" },
      ],
    });
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    const snapshots = readySnapshots(store.listAccounts());
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => selector.select({
      requestId: `req-race-${String(index)}`,
      poolId: pool.id,
      policy,
      required: [],
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: snapshots,
    })));
    expect(new Set(results.map((item) => item.route.requestId)).size).toBe(8);
    expect(results.every((item) => item.route.accountPseudonym.startsWith("acct-fixture-"))).toBe(true);
    expect(selector.cursorFor(pool.id)).toBe(0);
    const counts = results.reduce<Record<string, number>>((acc, item) => {
      acc[item.route.accountPseudonym] = (acc[item.route.accountPseudonym] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts["acct-fixture-001"]).toBe(4);
    expect(counts["acct-fixture-002"]).toBe(4);
    store.close();
  });

  it("serializes concurrent outcome writes for one account", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const left = await ControlPlaneStore.open(directory, { clock: () => now });
    const { accounts } = createReadyPool(left, {
      strategy: "fill-first",
      specs: [{ pseudonym: "acct-fixture-001", handle: "cred-001" }],
    });
    const account = accounts[0];
    if (!account) throw new Error("expected account");
    const right = await ControlPlaneStore.open(directory, { clock: () => now });
    const results = await Promise.allSettled([
      Promise.resolve().then(() => left.recordRouteOutcome(account.id, { outcome: "transient", cooldownUntil: "2026-08-13T00:01:00.000Z" })),
      Promise.resolve().then(() => right.recordRouteOutcome(account.id, { outcome: "auth", cooldownUntil: "2026-08-13T00:02:00.000Z" })),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(2);
    const current = left.getAccount(account.id);
    expect(current.version).toBeGreaterThanOrEqual(account.version + 2);
    expect(left.getHealth(account.id)?.consecutiveFailures).toBe(2);
    left.close();
    right.close();
  });
});
