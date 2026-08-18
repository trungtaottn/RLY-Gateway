import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent } from "../../src/core/canonical-event.js";
import type { CanonicalRequest } from "../../src/core/canonical-request.js";
import type { PolicyRevision } from "../../src/control-plane/types.js";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { AffinityStore } from "../../src/routing/pools/affinity.js";
import { RouteSelector } from "../../src/routing/pools/selector.js";
import { streamPoolRequest } from "../../src/routing/pools/execute.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function request(id: string): CanonicalRequest {
  const canonical: CanonicalRequest = {
    id,
    source: { protocol: "anthropic-messages", protocolVersion: "2023-06-01" },
    requestedModel: "nvidia/nemotron-3.5-lightning:free",
    modelRole: "primary",
    system: [],
    input: [],
    messages: [],
    tools: [],
    stream: true,
    inference: {},
    metadata: {},
  };
  return Object.freeze(canonical);
}

function event(sequence: number, type: string, extra: Record<string, unknown> = {}): CanonicalEvent {
  return { requestId: "req-term", sequence, timestamp: "2026-08-16T00:00:00.000Z", providerId: "openrouter", modelId: "nvidia/nemotron-3.5-lightning:free", type, ...extra } as CanonicalEvent;
}

/** Upstream stream that ends NATURALLY but never emits a terminal event. */
function* truncatedStream(): Generator<CanonicalEvent> {
  yield event(0, "response-started", { responseId: "resp_trunc" });
  yield event(1, "content-started", { index: 0, contentType: "text" });
  yield event(2, "text-delta", { index: 0, text: "PARTIAL" });
  yield event(3, "content-completed", { index: 0 });
  // No response-completed — iterator ends cleanly.
}

/** Healthy upstream stream with a terminal event. */
function* healthyStream(): Generator<CanonicalEvent> {
  yield event(0, "response-started", { responseId: "resp_ok" });
  yield event(1, "content-started", { index: 0, contentType: "text" });
  yield event(2, "text-delta", { index: 0, text: "OK" });
  yield event(3, "content-completed", { index: 0 });
  yield event(4, "response-completed", { stopReason: "end_turn" });
}

async function seed(directory: string): Promise<{ store: ControlPlaneStore; selector: RouteSelector; policy: PolicyRevision; accountId: string }> {
  const store = await ControlPlaneStore.open(directory);
  const provider = store.createProvider({ name: "openrouter", integrationMode: "direct", endpointPolicy: "loopback" }, "cli");
  const account = store.createAccount({ pseudonym: "acct-term", providerId: provider.id, credentialHandle: "env:OPENROUTER_API_KEY" }, "cli");
  const ready = store.bindCredential(account.id, account.version, { credentialHandle: "env:OPENROUTER_API_KEY", credentialGeneration: 1, state: "ready" }, "cli");
  store.createPool({ name: "term-pool", providerId: provider.id, strategy: "fill-first", retryBudget: 0, accountIds: [ready.id] }, "cli");
  const policy = store.currentPolicy();
  if (!policy) throw new Error("missing policy");
  const selector = new RouteSelector(store, new AffinityStore(directory));
  return { store, selector, policy, accountId: ready.id };
}

function collect(iterable: AsyncIterable<CanonicalEvent>): Promise<{ events: CanonicalEvent[]; error?: unknown }> {
  return (async () => {
    const events: CanonicalEvent[] = [];
    try {
      for await (const event of iterable) events.push(event);
      return { events };
    } catch (error) {
      return { events, error };
    }
  })();
}

/**
 * #J6 core terminal-event invariant: the pool executor must never record a
 * truncated upstream stream (natural end without `response-completed`) as
 * SUCCESS. Natural exhaustion without a terminal event fails closed (transient
 * outcome + cooldown, no silent success), while a healthy terminal stream
 * still records success.
 */
describe("pool executor terminal-event invariant (#J6)", () => {
  const capabilities = {
    streaming: true,
    tools: true,
    parallelTools: false,
    images: false,
    reasoning: false,
    redactedReasoning: false,
    structuredOutput: false,
    tokenCounting: "conservative-estimate" as const,
  };
  const credentialSnapshots = new Map([["env:OPENROUTER_API_KEY", { present: true, generation: 1 }]]);

  it("fails closed when the provider stream ends naturally without a terminal event", async () => {
    const directory = await temporaryDirectory("rly-term-trunc-");
    const { store, selector, policy, accountId } = await seed(directory);
    const { events, error } = await collect(streamPoolRequest({
      selector,
      store,
      request: request("req-trunc"),
      select: {
        poolId: policy.snapshot.pools[0]?.id ?? "missing",
        policy,
        required: [],
        capabilities,
        modelId: "nvidia/nemotron-3.5-lightning:free",
        adapterId: "openrouter-direct",
        role: "primary",
        credentialSnapshots,
        sessionKey: "lease-term",
      },
      invoke: () => truncatedStream(),
      signal: new AbortController().signal,
    }));
    // The truncated stream must NOT be recorded as success: an error surfaces
    // and the account gets a non-success (transient) outcome. Output had
    // already started, so the attempt is sealed (never rotated/replayed).
    expect(error).toBeDefined();
    expect(events.some((item) => item.type === "response-completed")).toBe(false);
    const account = store.getAccount(accountId);
    expect(account.cooldownUntil).toBeDefined();
    expect(account.cooldownUntil).not.toBeNull();
  });

  it("surfaces a typed incomplete-stream failure when no output preceded the truncation", async () => {
    const directory = await temporaryDirectory("rly-term-pre-");
    const { store, selector, policy, accountId } = await seed(directory);
    function* preOutputTruncated(): Generator<CanonicalEvent> {
      // Provider accepted the request but produced no output and no terminal.
      yield event(0, "response-started", { responseId: "resp_pre" });
    }
    const { error } = await collect(streamPoolRequest({
      selector,
      store,
      request: request("req-pre"),
      select: {
        poolId: policy.snapshot.pools[0]?.id ?? "missing",
        policy,
        required: [],
        capabilities,
        modelId: "nvidia/nemotron-3.5-lightning:free",
        adapterId: "openrouter-direct",
        role: "primary",
        credentialSnapshots,
        sessionKey: "lease-pre",
      },
      invoke: () => preOutputTruncated(),
      signal: new AbortController().signal,
    }));
    expect(error).toBeDefined();
    if (error instanceof Error) expect(error.message).toContain("terminal");
    const account = store.getAccount(accountId);
    expect(account.cooldownUntil).toBeDefined();
  });

  it("records success only when a terminal event is present", async () => {
    const directory = await temporaryDirectory("rly-term-ok-");
    const { store, selector, policy, accountId } = await seed(directory);
    const { events, error } = await collect(streamPoolRequest({
      selector,
      store,
      request: request("req-ok"),
      select: {
        poolId: policy.snapshot.pools[0]?.id ?? "missing",
        policy,
        required: [],
        capabilities,
        modelId: "nvidia/nemotron-3.5-lightning:free",
        adapterId: "openrouter-direct",
        role: "primary",
        credentialSnapshots,
        sessionKey: "lease-ok",
      },
      invoke: () => healthyStream(),
      signal: new AbortController().signal,
    }));
    expect(error).toBeUndefined();
    expect(events.some((item) => item.type === "response-completed")).toBe(true);
    const account = store.getAccount(accountId);
    expect(account.cooldownUntil).toBeUndefined();
    expect(account.quotaClass).toBe("healthy");
  });
});
