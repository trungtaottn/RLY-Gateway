import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { markOutputStarted } from "../../src/routing/effective-route.js";
import { StaleRouteBindingError } from "../../src/routing/errors.js";
import { CAPABILITIES, createReadyPool, createSelector, openStore, readySnapshots, tempDir } from "./helpers.js";

const directories: string[] = [];
const now = new Date("2026-08-13T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("EffectiveRoute binding", () => {
  it("binds one account and credential generation into an immutable route", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { accounts, pool } = createReadyPool(store, {
      strategy: "fill-first",
      specs: [{ pseudonym: "acct-fixture-001", handle: "cred-001", generation: 4 }],
    });
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    const selected = await selector.select({
      requestId: "req-bind",
      poolId: pool.id,
      policy,
      required: ["streaming"],
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: readySnapshots(accounts),
    });
    expect(selected.route.accountPseudonym).toBe("acct-fixture-001");
    expect(selected.route.credentialGeneration).toBe(4);
    expect(selected.route.policyRevision).toBe(policy.revision);
    expect(selected.route.outputStarted).toBe(false);
    expect(Object.isFrozen(selected.route)).toBe(true);
    expect(Object.isFrozen(selected.trace)).toBe(true);
    const sealed = markOutputStarted(selected.route);
    expect(sealed.outputStarted).toBe(true);
    expect(selected.route.outputStarted).toBe(false);
    store.close();
  });

  it("revalidates generation and eligibility immediately before invoke", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { accounts, pool } = createReadyPool(store, {
      strategy: "manual",
      specs: [{ pseudonym: "acct-fixture-001", handle: "cred-001" }],
    });
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    const input = {
      poolId: pool.id,
      policy,
      required: [] as const,
      capabilities: CAPABILITIES,
      credentialSnapshots: readySnapshots(accounts),
    };
    const selected = await selector.select({
      ...input,
      requestId: "req-revalidate",
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
    });
    selector.revalidate(selected.route, input);
    const account = accounts[0];
    if (!account) throw new Error("expected account");
    store.updateAccount(account.id, account.version, { state: "paused", pauseReason: "owner" }, "cli");
    expect(() => selector.revalidate(selected.route, {
      ...input,
      policy: store.currentPolicy() ?? input.policy,
    })).toThrow(StaleRouteBindingError);
    store.close();
  });

  it("rejects a generation mismatch before invoke", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { accounts, pool } = createReadyPool(store, {
      strategy: "manual",
      specs: [{ pseudonym: "acct-fixture-001", handle: "cred-001", generation: 1 }],
    });
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    const selected = await selector.select({
      requestId: "req-gen",
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
    store.bindCredential(account.id, store.getAccount(account.id).version, {
      credentialHandle: account.credentialHandle,
      credentialGeneration: 2,
      state: "ready",
    }, "cli");
    expect(() => selector.revalidate(selected.route, {
      poolId: pool.id,
      policy: store.currentPolicy() ?? policy,
      required: [],
      capabilities: CAPABILITIES,
      credentialSnapshots: new Map([[account.credentialHandle, { present: true, generation: 2 }]]),
    })).toThrow(StaleRouteBindingError);
    store.close();
  });
});
