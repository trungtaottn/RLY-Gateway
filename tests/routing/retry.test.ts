import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { CanonicalEvent } from "../../src/core/canonical-event.js";
import type { CanonicalRequest } from "../../src/core/canonical-request.js";
import { RouteSealedError } from "../../src/routing/errors.js";
import type { EffectiveRoute } from "../../src/routing/effective-route.js";
import { executePoolRequest, RouteFailure, type PoolInvoke } from "../../src/routing/pools/execute.js";
import { canRotate, isOutputOrToolEvent } from "../../src/routing/pools/retry.js";
import { CAPABILITIES, createReadyPool, createSelector, openStore, readySnapshots, tempDir } from "./helpers.js";

const directories: string[] = [];
const now = new Date("2026-08-13T00:00:00.000Z");

const request: CanonicalRequest = {
  id: "req-retry",
  source: { protocol: "anthropic-messages" },
  requestedModel: "fixture-model",
  modelRole: "primary",
  system: [],
  input: [],
  messages: [],
  tools: [],
  stream: false,
  inference: {},
  metadata: {},
};

function event(type: CanonicalEvent["type"], extra: object = {}): CanonicalEvent {
  return {
    requestId: request.id,
    sequence: 0,
    timestamp: now.toISOString(),
    providerId: "fixture",
    modelId: "fixture-model",
    type,
    ...extra,
  } as CanonicalEvent;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("bounded retry", () => {
  it("rotates only before the first output or tool event and within budget", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { pool } = createReadyPool(store, {
      strategy: "round-robin",
      retryBudget: 1,
      specs: [
        { pseudonym: "acct-fixture-001", handle: "cred-001" },
        { pseudonym: "acct-fixture-002", handle: "cred-002" },
      ],
    });
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    let calls = 0;
    const invoke: PoolInvoke = function* (route: EffectiveRoute) {
      calls += 1;
      if (route.accountPseudonym === "acct-fixture-001") {
        yield event("response-failed", { code: "authentication_error", message: "synthetic" });
        return;
      }
      yield event("response-started", { responseId: "msg-fixture" });
      yield event("content-started", { index: 0, contentType: "text" });
      yield event("text-delta", { index: 0, text: "ok" });
      yield event("response-completed", { stopReason: "end_turn" });
    };
    const result = await executePoolRequest({
      selector,
      store,
      request,
      select: {
        poolId: pool.id,
        policy,
        required: [],
        capabilities: CAPABILITIES,
        modelId: "fixture-model",
        adapterId: "fixture-adapter",
        role: "primary",
        credentialSnapshots: readySnapshots(store.listAccounts()),
      },
      invoke,
      signal: new AbortController().signal,
    });
    expect(calls).toBe(2);
    expect(result.route.accountPseudonym).toBe("acct-fixture-002");
    expect(result.traces).toHaveLength(2);
    expect(store.getAccount(result.route.accountId).quotaClass).not.toBe("exhausted");
    store.close();
  });

  it("does not invoke a second account after a text or tool event", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { pool } = createReadyPool(store, {
      strategy: "round-robin",
      retryBudget: 2,
      specs: [
        { pseudonym: "acct-fixture-001", handle: "cred-001" },
        { pseudonym: "acct-fixture-002", handle: "cred-002" },
      ],
    });
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    let calls = 0;
    const invoke: PoolInvoke = function* () {
      calls += 1;
      yield event("content-started", { index: 0, contentType: "tool-call", toolCallId: "tool-1", toolName: "fixture" });
      yield event("tool-arguments-delta", { index: 0, toolCallId: "tool-1", partialJson: "{}" });
      yield event("response-failed", { code: "api_error", message: "synthetic" });
    };
    await expect(executePoolRequest({
      selector,
      store,
      request,
      select: {
        poolId: pool.id,
        policy,
        required: [],
        capabilities: CAPABILITIES,
        modelId: "fixture-model",
        adapterId: "fixture-adapter",
        role: "primary",
        credentialSnapshots: readySnapshots(store.listAccounts()),
      },
      invoke,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(RouteSealedError);
    expect(calls).toBe(1);
    store.close();
  });

  it("does not persist an aborted invoke as a route outcome", async () => {
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
    const abort = new Error("client disconnected");
    abort.name = "AbortError";
    await expect(executePoolRequest({
      selector,
      store,
      request,
      select: {
        poolId: pool.id,
        policy,
        required: [],
        capabilities: CAPABILITIES,
        modelId: "fixture-model",
        adapterId: "fixture-adapter",
        role: "primary",
        credentialSnapshots: readySnapshots(accounts),
      },
      invoke: () => { throw abort; },
      signal: new AbortController().signal,
    })).rejects.toBe(abort);
    const account = accounts[0];
    if (!account) throw new Error("expected account");
    expect(store.getHealth(account.id)?.consecutiveFailures).toBe(0);
    expect(store.listAudit().some((event) => event.action === "route.outcome")).toBe(false);
    store.close();
  });

  it("classifies output and tool events as the retry boundary", () => {
    expect(isOutputOrToolEvent(event("text-delta", { index: 0, text: "x" }))).toBe(true);
    expect(isOutputOrToolEvent(event("tool-arguments-delta", { index: 0, toolCallId: "t", partialJson: "{}" }))).toBe(true);
    expect(isOutputOrToolEvent(event("response-started", { responseId: "r" }))).toBe(false);
    expect(canRotate({ outputStarted: false, rotationsUsed: 0, retryBudget: 1, outcome: "auth", commitment: "not-sent" })).toBe(true);
    expect(canRotate({ outputStarted: true, rotationsUsed: 0, retryBudget: 1, outcome: "auth", commitment: "not-sent" })).toBe(false);
    expect(canRotate({ outputStarted: false, rotationsUsed: 1, retryBudget: 1, outcome: "transient", commitment: "not-sent" })).toBe(false);
    // #121: commitment past not-sent (unknown / provider-accepted) never rotates.
    expect(canRotate({ outputStarted: false, rotationsUsed: 0, retryBudget: 1, outcome: "auth", commitment: "unknown" })).toBe(false);
    expect(canRotate({ outputStarted: false, rotationsUsed: 0, retryBudget: 1, outcome: "quota", commitment: "provider-accepted" })).toBe(false);
    expect(canRotate({ outputStarted: false, rotationsUsed: 0, retryBudget: 1, outcome: "transient", commitment: "sent-unacknowledged" })).toBe(false);
    expect(RouteFailure).toBeTypeOf("function");
  });
});
