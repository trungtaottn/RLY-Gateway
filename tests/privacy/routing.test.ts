import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { assertSecretFree } from "../../src/control-plane/secret-free.js";
import { CAPABILITIES, createReadyPool, createSelector, openStore, readySnapshots, tempDir } from "../routing/helpers.js";

const directories: string[] = [];
const now = new Date("2026-08-13T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("routing privacy", () => {
  it("keeps decision traces and outcome audit free of secrets and identity", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { accounts, pool } = createReadyPool(store, {
      strategy: "fill-first",
      specs: [{ pseudonym: "acct-fixture-001", handle: "cred-001" }],
    });
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    const selected = await selector.select({
      requestId: "req-privacy",
      poolId: pool.id,
      policy,
      required: [],
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: readySnapshots(accounts),
    });
    const account = accounts[0];
    if (!account) throw new Error("expected account");
    store.recordRouteOutcome(account.id, { outcome: "transient", cooldownUntil: "2026-08-13T00:01:00.000Z" });
    const audit = store.listAudit().find((event) => event.action === "route.outcome");
    assertSecretFree(selected.trace);
    expect(JSON.stringify(selected.trace)).not.toMatch(/accessToken|refreshToken|authorization|email|prompt|response/i);
    expect(JSON.stringify(selected.trace)).not.toContain(selected.route.credentialHandle);
    expect(selected.trace.candidates[0]).not.toHaveProperty("accountId");
    if (audit) {
      assertSecretFree(audit);
      expect(JSON.stringify(audit)).not.toMatch(/accessToken|refreshToken|authorization/i);
    }
    store.close();
  });
});
