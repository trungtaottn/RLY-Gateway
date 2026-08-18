import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { CanonicalEvent } from "../../src/core/canonical-event.js";
import type { CanonicalRequest } from "../../src/core/canonical-request.js";
import type { CommitmentState } from "../../src/providers/commitment.js";
import { ProviderAdapterError } from "../../src/providers/provider-adapter.js";
import type { EffectiveRoute } from "../../src/routing/effective-route.js";
import { executePoolRequest, type PoolInvoke } from "../../src/routing/pools/execute.js";
import { CAPABILITIES, createReadyPool, createSelector, openStore, readySnapshots, tempDir } from "../routing/helpers.js";

const directories: string[] = [];
const now = new Date("2026-08-15T00:00:00.000Z");

const request: CanonicalRequest = {
  id: "req-chaos",
  source: { protocol: "openai-responses" },
  requestedModel: "fixture-model",
  modelRole: "primary",
  system: [],
  input: [],
  messages: [],
  tools: [{ name: "fixture_tool", inputSchema: {} }],
  stream: true,
  inference: {},
  metadata: {},
};

function event(sequence: number, type: CanonicalEvent["type"], extra: object = {}): CanonicalEvent {
  return {
    requestId: request.id,
    sequence,
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

type ChaosStage =
  | "before-send"            // fails before the request body is written (not-sent)
  | "after-send"             // network failure after send, before any response (unknown)
  | "provider-accepted"      // provider acknowledged, then fails (never rotate)
  | "during-streaming"       // output started, then fails (never rotate)
  | "tool-boundary"          // tool call crossed the boundary, then fails (never rotate)
  | "clean";                 // completes normally

/**
 * A chaos invoke that emulates a provider that fails at a configured
 * commitment stage. `toolExecutions` counts tool side effects that would have
 * happened if a client executed the returned tool call — the invariant under
 * test is that a retried/failed attempt NEVER duplicates them.
 */
function chaosInvoke(stage: ChaosStage, toolExecutions: { count: number }): PoolInvoke {
  return function* (route: EffectiveRoute, signal: AbortSignal): Generator<CanonicalEvent> {
    void route; void signal;
    if (stage === "before-send") {
      throw new ProviderAdapterError("authentication_error", "synthetic auth failure", undefined, "not-sent");
    }
    if (stage === "after-send") {
      throw new ProviderAdapterError("api_error", "synthetic network failure", undefined, "unknown");
    }
    if (stage === "provider-accepted") {
      yield event(0, "response-started", { responseId: "resp_chaos" });
      throw new ProviderAdapterError("api_error", "synthetic failure after acceptance", undefined, "provider-accepted");
    }
    if (stage === "during-streaming") {
      yield event(0, "response-started", { responseId: "resp_chaos" });
      yield event(1, "content-started", { index: 0, contentType: "text" });
      yield event(2, "text-delta", { index: 0, text: "partial output " });
      throw new ProviderAdapterError("api_error", "synthetic stream failure", undefined, "client-output-started");
    }
    if (stage === "tool-boundary") {
      yield event(0, "response-started", { responseId: "resp_chaos" });
      yield event(1, "content-started", { index: 0, contentType: "tool-call", toolCallId: "tool_chaos", toolName: "fixture_tool" });
      yield event(2, "tool-arguments-delta", { index: 0, toolCallId: "tool_chaos", partialJson: "{}" });
      toolExecutions.count += 1; // the client WOULD execute the tool here
      throw new ProviderAdapterError("api_error", "synthetic failure after tool boundary", undefined, "tool-boundary");
    }
    yield event(0, "response-started", { responseId: "resp_chaos" });
    yield event(1, "content-started", { index: 0, contentType: "tool-call", toolCallId: "tool_chaos", toolName: "fixture_tool" });
    yield event(2, "tool-arguments-delta", { index: 0, toolCallId: "tool_chaos", partialJson: "{}" });
    toolExecutions.count += 1;
    yield event(3, "content-completed", { index: 0 });
    yield event(4, "response-completed", { stopReason: "tool_use" });
  };
}

async function runChaos(stage: ChaosStage): Promise<{ invocations: number; toolExecutions: number; error: unknown; accountsTried: string[] }> {
  const directory = await tempDir();
  directories.push(directory);
  const store = await openStore(directory, now);
  const { accounts, pool } = createReadyPool(store, {
    strategy: "round-robin",
    retryBudget: 1,
    specs: [
      { pseudonym: "acct-chaos-001", handle: "cred-001" },
      { pseudonym: "acct-chaos-002", handle: "cred-002" },
    ],
  });
  const selector = createSelector(store, now);
  const policy = store.currentPolicy();
  if (!policy) throw new Error("expected policy");
  let invocations = 0;
  const toolExecutions = { count: 0 };
  const accountsTried: string[] = [];
  const inner = chaosInvoke(stage, toolExecutions);
  const invoke: PoolInvoke = async function* (route: EffectiveRoute, signal: AbortSignal) {
    invocations += 1;
    accountsTried.push(route.accountPseudonym);
    // The chaos failure applies to the FIRST attempt; any later attempt (a
    // safe not-sent rotation) completes cleanly so the invariant under test is
    // exactly the rotation decision, never the second attempt's outcome.
    if (invocations === 1) yield* inner(route, signal);
    else yield* chaosInvoke("clean", toolExecutions)(route, signal);
  };
  let error: unknown;
  try {
    await executePoolRequest({
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
      invoke,
      signal: new AbortController().signal,
    });
  } catch (caught) {
    error = caught;
  }
  store.close();
  return { invocations, toolExecutions: toolExecutions.count, error, accountsTried };
}

describe("chaos: failures at every commitment stage never duplicate tool side effects (#121)", () => {
  it("before-send failure (not-sent) rotates within budget", async () => {
    const result = await runChaos("before-send");
    expect(result.error).toBeUndefined();
    expect(result.invocations).toBe(2);
    expect(result.accountsTried).toEqual(["acct-chaos-001", "acct-chaos-002"]);
    // The failed attempt never reached the tool boundary; only the surviving
    // clean attempt emits its own tool call (exactly once).
    expect(result.toolExecutions).toBe(1);
  });

  it("network failure after send (unknown outcome) never rotates", async () => {
    const result = await runChaos("after-send");
    expect(result.error).toBeInstanceOf(ProviderAdapterError);
    expect((result.error as ProviderAdapterError).commitment).toBe("unknown");
    expect(result.invocations).toBe(1);
    expect(result.toolExecutions).toBe(0);
  });

  it("failure after provider acceptance never rotates", async () => {
    const result = await runChaos("provider-accepted");
    expect(result.error).toBeInstanceOf(ProviderAdapterError);
    expect((result.error as ProviderAdapterError).commitment).toBe("provider-accepted");
    expect(result.invocations).toBe(1);
    expect(result.toolExecutions).toBe(0);
  });

  it("failure during streaming (output started) never rotates", async () => {
    const result = await runChaos("during-streaming");
    expect(result.error).toBeInstanceOf(ProviderAdapterError);
    expect((result.error as ProviderAdapterError).commitment).toBe("client-output-started");
    expect(result.invocations).toBe(1);
    expect(result.toolExecutions).toBe(0);
  });

  it("failure after the tool boundary never rotates and never duplicates the tool side effect", async () => {
    const result = await runChaos("tool-boundary");
    expect(result.error).toBeInstanceOf(ProviderAdapterError);
    expect((result.error as ProviderAdapterError).commitment).toBe("tool-boundary");
    expect(result.invocations).toBe(1);
    expect(result.toolExecutions).toBe(1); // exactly once — no replay, no failover
  });

  it("a clean run after a not-sent rotation executes the tool exactly once on the surviving account", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { accounts, pool } = createReadyPool(store, {
      strategy: "fill-first",
      retryBudget: 1,
      specs: [
        { pseudonym: "acct-chaos-001", handle: "cred-001" },
        { pseudonym: "acct-chaos-002", handle: "cred-002" },
      ],
    });
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    let invocations = 0;
    const toolExecutions = { count: 0 };
    const invoke: PoolInvoke = async function* (route: EffectiveRoute, signal: AbortSignal) {
      invocations += 1;
      if (route.accountPseudonym === "acct-chaos-001") {
        throw new ProviderAdapterError("authentication_error", "synthetic", undefined, "not-sent");
      }
      yield* chaosInvoke("clean", toolExecutions)(route, signal);
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
        credentialSnapshots: readySnapshots(accounts),
      },
      invoke,
      signal: new AbortController().signal,
    });
    expect(invocations).toBe(2);
    expect(toolExecutions.count).toBe(1);
    expect(result.route.accountPseudonym).toBe("acct-chaos-002");
    store.close();
  });

  it("commitment state machine advances in the documented order and is secret-free metadata", async () => {
    const { COMMITMENT_STATES, commitmentAllowsRetry, isProviderCommitted, commitmentRank } = await import("../../src/providers/commitment.js");
    expect(COMMITMENT_STATES).toEqual(["not-sent", "sent-unacknowledged", "provider-accepted", "client-output-started", "tool-boundary", "unknown"]);
    expect(commitmentAllowsRetry("not-sent")).toBe(true);
    for (const state of COMMITMENT_STATES.filter((item): item is Exclude<CommitmentState, "not-sent"> => item !== "not-sent")) {
      expect(commitmentAllowsRetry(state)).toBe(false);
    }
    expect(isProviderCommitted("provider-accepted")).toBe(true);
    expect(isProviderCommitted("tool-boundary")).toBe(true);
    expect(isProviderCommitted("not-sent")).toBe(false);
    expect(commitmentRank("not-sent")).toBe(0);
    expect(commitmentRank("tool-boundary")).toBe(4);
  });
});
