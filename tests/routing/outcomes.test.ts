import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CAPABILITIES, createReadyPool, createSelector, openStore, readySnapshots, tempDir } from "./helpers.js";

const directories: string[] = [];
const now = new Date("2026-08-13T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("route outcomes", () => {
  it("updates health, quota class, cooldown, and audit in one transaction", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { accounts } = createReadyPool(store, {
      strategy: "fill-first",
      specs: [{ pseudonym: "acct-fixture-001", handle: "cred-001" }],
    });
    const account = accounts[0];
    if (!account) throw new Error("expected account");
    const before = store.currentPolicy()?.revision ?? 0;
    const updated = store.recordRouteOutcome(account.id, {
      outcome: "quota",
      quotaClass: "exhausted",
      cooldownUntil: "2026-08-13T00:05:00.000Z",
    });
    expect(updated.quotaClass).toBe("exhausted");
    expect(updated.cooldownUntil).toBe("2026-08-13T00:05:00.000Z");
    expect(store.getHealth(account.id)?.lastOutcome).toBe("quota");
    expect(store.getHealth(account.id)?.consecutiveFailures).toBe(1);
    expect(store.currentPolicy()?.revision).toBe(before);
    expect(store.listAudit().some((event) => event.action === "route.outcome" && event.result === "ok")).toBe(true);
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    await expect(selector.select({
      requestId: "req-cooled",
      poolId: policy.snapshot.pools[0]?.id ?? "",
      policy,
      required: [],
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: readySnapshots([updated]),
    })).rejects.toThrow("No eligible account");
    const cleared = store.recordRouteOutcome(updated.id, { outcome: "success", cooldownUntil: null });
    expect(cleared.cooldownUntil).toBeUndefined();
    expect(store.getHealth(cleared.id)?.consecutiveFailures).toBe(0);
    store.close();
  });

  it("rolls back an interrupted outcome write", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { accounts } = createReadyPool(store, {
      strategy: "manual",
      specs: [{ pseudonym: "acct-fixture-001", handle: "cred-001" }],
    });
    const account = accounts[0];
    if (!account) throw new Error("expected account");
    store.database.exec("BEGIN IMMEDIATE");
    store.database.prepare("UPDATE health SET last_outcome = ?, consecutive_failures = 9 WHERE account_id = ?")
      .run("quota", account.id);
    store.close();
    const restored = await openStore(directory, now);
    expect(restored.getHealth(account.id)?.consecutiveFailures).toBe(0);
    expect(restored.getHealth(account.id)?.lastOutcome).toBeUndefined();
    restored.close();
  });
});
