import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { LaunchSessionRegistry } from "../../src/profiles/sessions.js";
import { RouteTraceRing } from "../../src/profiles/traces.js";
import { createGatewayServer } from "../../src/runtime/gateway-server.js";
import { LeaseManager } from "../../src/runtime/lease-manager.js";
import { AgentExecutionContextRegistry } from "../../src/profiles/agent-contexts.js";
import { AffinityStore } from "../../src/routing/pools/affinity.js";
import { RouteSelector } from "../../src/routing/pools/selector.js";
import { gatewayConfigSchema } from "../../src/config/schema.js";
import { projectionIdFor } from "../../src/routing/model-projection/project.js";
import { CLAUDE_CODE_CONTRACT } from "../../src/canary/client-fixtures.js";
import { ClaimEvidenceStore } from "../../src/canary/artifact.js";
import { EffectiveCompatibilityRegistry } from "../../src/compatibility/registry.js";
import { ReviewDecisionStore, QuarantineStore } from "../../src/compatibility/stores.js";
import { runtimeCompatibilityPolicy } from "../../src/compatibility/policy.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import { deriveClaudeViewId } from "../../src/runtime/claude-overlay.js";
import { seedClineClaudeProfile, sseFixture, CLINE_FIXTURE_ACCESS_A, CLINE_FIXTURE_ACCESS_B } from "../helpers/cline-profile-seed.js";

/**
 * W3-T3 EffectiveModelDecision control plane (#127) — runtime-consumer
 * lifecycle. Every supported RLY model-routing request produces ONE typed
 * EffectiveModelDecision before account selection; the physical
 * provider/model/reasoning target is frozen (account failover cannot change
 * it); subagent decisions stay isolated; profile-view persisted state is
 * validated per owning view and stale/foreign projections fail closed; and
 * decision/diagnostics output stays secret-free.
 */

const directories: string[] = [];
let app: FastifyInstance | undefined;
let store: ControlPlaneStore | undefined;
let broker: CredentialBroker | undefined;
let provider: FastifyInstance | undefined;
let leases: LeaseManager | undefined;
let agentContexts: AgentExecutionContextRegistry | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await provider?.close();
  provider = undefined;
  await broker?.close();
  broker = undefined;
  store?.close();
  store = undefined;
  leases?.dispose();
  leases = undefined;
  agentContexts = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface DecisionTraceShape {
  effectiveModelDecision?: {
    intent?: { kind?: string; sourceSelector?: string; source?: string; tier?: string; alias?: string; modelId?: string; role?: string };
    precedence?: { winner?: string; resolvedThrough?: string; conflicts?: { kind?: string; detail?: string }[] };
    target?: { accessProviderId?: string; physicalModelId?: string; logicalId?: string; modelFamily?: string; adapterId?: string };
    provenance?: {
      projection?: { projectionId?: string };
      tier?: { requestedTier?: string };
      clientAlias?: { alias?: string; mappedTier?: string };
      inherit?: { parentModelId?: string; parentModelFamily?: string; contextSource?: string };
      profileRole?: string;
      launchPolicyModel?: string;
      persistedViewModel?: string;
      defaulted?: boolean;
    };
    reasoning?: { canonicalIntent?: string; mappingKind?: string };
    compatibility?: { authority?: string; effectiveLabel?: string; enforcementReason?: string; seedState?: string };
    poolBinding?: { poolId?: string; providerId?: string; policyRevision?: number; experimentalModels?: boolean };
    revisions?: { policyRevision?: number; registryRevision?: number; mappingRevision?: number; sessionUniverseRevision?: number };
    reasons?: { code?: string }[];
    blockedAlternatives?: { logicalId?: string; physicalModelId?: string; blockedBy?: string[] }[];
    decidedAt?: string;
  };
  selected?: { accountPseudonym?: string };
}

async function openApp(
  directory: string,
  endpoint: string,
  input: Readonly<{
    modelRoles?: Readonly<Record<string, string>>;
    experimentalModels?: boolean;
    environment?: Readonly<NodeJS.ProcessEnv>;
    accounts?: readonly { pseudonym: string; access: string; refresh: string }[];
    retryBudget?: number;
    strategy?: "manual" | "round-robin" | "fill-first";
    profileName?: string;
  }> = {},
) {
  store = await ControlPlaneStore.open(directory);
  broker = await CredentialBroker.open(directory);
  await seedClineClaudeProfile(store, broker, directory, {
    endpoint,
    ...(input.modelRoles === undefined ? {} : { modelRoles: input.modelRoles }),
    ...(input.accounts === undefined ? {} : { accounts: input.accounts }),
    ...(input.retryBudget === undefined ? {} : { retryBudget: input.retryBudget }),
    ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
    ...(input.profileName === undefined ? {} : { profileName: input.profileName }),
  });
  leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
  const sessions = new LaunchSessionRegistry((id) => leases?.has(id) === true);
  const traces = new RouteTraceRing();
  agentContexts = new AgentExecutionContextRegistry((id) => leases?.has(id) === true);
  const config = gatewayConfigSchema.parse({
    schemaVersion: 1,
    gateway: {
      port: 17892,
      logLevel: "silent",
      ...(input.experimentalModels === true ? { modelDiscovery: { experimentalModels: true } } : {}),
    },
  });
  app = createGatewayServer({
    host: "127.0.0.1",
    port: 17892,
    authToken: "instance-secret",
    instanceId: "00000000-0000-4000-8000-000000000322",
    configFingerprint: "d".repeat(64),
    config,
    environment: input.environment ?? {},
    controlPlane: store,
    broker,
    selector: new RouteSelector(store, new AffinityStore(directory)),
    launchSessions: sessions,
    traces,
    leases,
    agentContexts,
    // #124: the Effective Compatibility Registry is the runtime compatibility
    // authority — decisions record its answers, never static state alone.
    compatibility: new EffectiveCompatibilityRegistry({
      claims: new ClaimEvidenceStore(directory),
      reviews: new ReviewDecisionStore(directory),
      quarantines: new QuarantineStore(directory),
      policy: runtimeCompatibilityPolicy({
        supportedClientBaseline: CLAUDE_CODE_CONTRACT.baseline,
        pinnedProtocolRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
        pinnedFixtureRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
        rlyBuildVersion: RUNTIME_VERSION,
      }),
    }),
  });
  return { traces, agentContexts };
}

function requireApp(): FastifyInstance {
  if (!app) throw new Error("missing gateway");
  return app;
}

async function issueToken(profileName = "clinepass"): Promise<string> {
  const leaseId = "00000000-0000-4000-8000-000000000323";
  if (!leases) throw new Error("missing leases");
  await leases.add(leaseId);
  const issued = await requireApp().inject({
    method: "POST",
    url: "/v1/launch-sessions",
    headers: { authorization: "Bearer instance-secret", "content-type": "application/json" },
    payload: { profileName, leaseId },
  });
  expect(issued.statusCode).toBe(201);
  const body: unknown = issued.json();
  const token = body && typeof body === "object" && "token" in body && typeof body.token === "string" ? body.token : "";
  expect(token).not.toBe("");
  return token;
}

async function sendModel(
  token: string,
  model: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ statusCode: number; body: string; json: () => unknown }> {
  return requireApp().inject({
    method: "POST",
    url: "/v1/messages",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    payload: { model, max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
  });
}

async function latestTrace(token: string): Promise<DecisionTraceShape> {
  const listed = await requireApp().inject({
    method: "GET",
    url: "/v1/route-traces",
    headers: { authorization: `Bearer ${token}` },
  });
  const body: unknown = listed.json();
  const traces = body && typeof body === "object" && "traces" in body && Array.isArray(body.traces) ? body.traces : [];
  const last = traces.at(-1) as DecisionTraceShape | undefined;
  return last ?? {};
}

function agentHeaders(session: string, agent: string, parent?: string): Record<string, string> {
  return {
    "x-claude-code-session-id": session,
    "x-claude-code-agent-id": agent,
    ...(parent === undefined ? {} : { "x-claude-code-parent-agent-id": parent }),
  };
}

describe("EffectiveModelDecision runtime lifecycle (#127)", () => {
  it("produces one typed decision before account selection for profile routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-model-decision-profile-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(sseFixture("model-decision", "DECISION_OK"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await openApp(directory, endpoint, {
      modelRoles: { primary: "gpt-5.6-terra" },
      environment: { ANTHROPIC_BASE_URL: "http://127.0.0.1:17892" },
    });
    const token = await issueToken();

    // Exact client model.
    const exact = await sendModel(token, "gpt-5.6-terra");
    expect(exact.statusCode).toBe(200);
    let trace = await latestTrace(token);
    const decision = trace.effectiveModelDecision;
    expect(decision).toBeDefined();
    expect(decision?.intent).toMatchObject({ kind: "EXACT_CLIENT_MODEL", sourceSelector: "gpt-5.6-terra" });
    expect(decision?.target).toMatchObject({ accessProviderId: "cline", physicalModelId: "gpt-5.6-terra", adapterId: "cline-interop" });
    expect(decision?.precedence?.winner).toBe("exact-client-model");
    expect(decision?.compatibility?.authority).toBe("ecr");
    expect(decision?.compatibility?.effectiveLabel).toBe("experimental");
    expect(decision?.compatibility?.enforcementReason).toBe("explicit-experimental-override");
    expect(decision?.reasoning?.mappingKind).toBe("default");
    expect(decision?.poolBinding?.providerId).toBe("cline");
    expect(decision?.revisions?.policyRevision).toBeGreaterThan(0);
    expect(decision?.revisions?.sessionUniverseRevision).toBeGreaterThan(0);
    expect(decision?.decidedAt).toBeDefined();
    // No account identity in the decision.
    expect(JSON.stringify(decision)).not.toMatch(/accountPseudonym|acct-cline|credentialGeneration/);
    expect(trace.selected?.accountPseudonym).toBe("acct-cline-a");

    // Bare alias tier route.
    const alias = await sendModel(token, "fable");
    expect(alias.statusCode).toBe(200);
    trace = await latestTrace(token);
    expect(trace.effectiveModelDecision?.intent?.kind).toBe("CLIENT_NATIVE_ALIAS");
    expect(trace.effectiveModelDecision?.precedence?.winner).toBe("client-native-alias");
    expect(trace.effectiveModelDecision?.provenance?.clientAlias?.alias).toBe("fable");
    expect(trace.effectiveModelDecision?.revisions?.mappingRevision).toBeDefined();

    // Explicit RLY logical tier route.
    const tier = await sendModel(token, "rly-tier:fable");
    expect(tier.statusCode).toBe(200);
    trace = await latestTrace(token);
    expect(trace.effectiveModelDecision?.intent?.kind).toBe("RLY_LOGICAL_TIER");
    expect(trace.effectiveModelDecision?.precedence?.winner).toBe("explicit-rly-tier");
    expect(trace.effectiveModelDecision?.provenance?.tier?.requestedTier).toBe("fable");
    expect(trace.effectiveModelDecision?.reasons?.map((reason) => reason.code)).toContain("tier-resolved");
    expect(trace.effectiveModelDecision?.target?.physicalModelId).toBe("gpt-5.6-sol");

    // default route resolves through the profile primary role.
    const byDefault = await sendModel(token, "default");
    expect(byDefault.statusCode).toBe(200);
    trace = await latestTrace(token);
    expect(trace.effectiveModelDecision?.intent?.kind).toBe("DEFAULT");
    expect(trace.effectiveModelDecision?.precedence?.winner).toBe("profile-policy");
    expect(trace.effectiveModelDecision?.provenance?.defaulted).toBe(true);
    expect(trace.effectiveModelDecision?.target?.physicalModelId).toBe("gpt-5.6-terra");
  });

  it("freezes the physical model before account selection — account failover cannot change it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-model-decision-freeze-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const headers = request.headers as Record<string, string | undefined>;
      const bearer = headers["authorization"] ?? "";
      // Account A fails authentication pre-output; account B succeeds.
      if (bearer.includes(CLINE_FIXTURE_ACCESS_A)) {
        return new Response(JSON.stringify({ error: { type: "authentication_error", message: "bad token" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(sseFixture("model-decision-freeze", "FREEZE_OK"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await openApp(directory, endpoint, {
      modelRoles: { primary: "gpt-5.6-terra" },
      accounts: [
        { pseudonym: "acct-cline-a", access: CLINE_FIXTURE_ACCESS_A, refresh: "cline-refresh-token-fixture-a-not-secret" },
        { pseudonym: "acct-cline-b", access: CLINE_FIXTURE_ACCESS_B, refresh: "cline-refresh-token-fixture-b-not-secret" },
      ],
      strategy: "fill-first",
      retryBudget: 1,
    });
    const token = await issueToken();
    const response = await sendModel(token, "gpt-5.6-terra");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("FREEZE_OK");

    // Account A was tried and failed; rotation landed on account B — but the
    // EffectiveModelDecision target/reasoning/pool is identical across every
    // attempt: the physical model is frozen before the RouteSelector.
    const listed = await requireApp().inject({
      method: "GET",
      url: "/v1/route-traces",
      headers: { authorization: `Bearer ${token}` },
    });
    const body: unknown = listed.json();
    const traces = body && typeof body === "object" && "traces" in body && Array.isArray(body.traces) ? body.traces : [];
    const decisions = (traces as DecisionTraceShape[]).map((item) => item.effectiveModelDecision).filter((item) => item !== undefined);
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    for (const decision of decisions) {
      expect(decision.target).toMatchObject({ accessProviderId: "cline", physicalModelId: "gpt-5.6-terra" });
      expect(decision.reasoning?.canonicalIntent).toBe(decisions[0]?.reasoning?.canonicalIntent);
      expect(decision.poolBinding?.poolId).toBe(decisions[0]?.poolBinding?.poolId);
      expect(JSON.stringify(decision)).not.toMatch(/accountPseudonym|acct-cline/);
    }
    const pseudonyms = (traces as DecisionTraceShape[]).map((item) => item.selected?.accountPseudonym).filter((item) => item !== undefined);
    expect(pseudonyms).toContain("acct-cline-a");
    expect(pseudonyms).toContain("acct-cline-b");
  });

  it("routes projections with the decision vocabulary and fails closed on foreign/stale projections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-model-decision-projection-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(sseFixture("model-decision-proj", "PROJ_OK"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await openApp(directory, endpoint, {
      modelRoles: { primary: "gpt-5.6-terra" },
      experimentalModels: true,
    });
    const token = await issueToken();
    const projection = projectionIdFor("cline", "gpt-5.6-terra");
    const persisted = await sendModel(token, projection);
    expect(persisted.statusCode).toBe(200);
    const trace = await latestTrace(token);
    expect(trace.effectiveModelDecision?.intent).toMatchObject({ kind: "EXACT_PROJECTION", sourceSelector: projection });
    expect(trace.effectiveModelDecision?.precedence?.winner).toBe("exact-projection");
    expect(trace.effectiveModelDecision?.precedence?.resolvedThrough).toBe("projection-reverse-map");
    expect(trace.effectiveModelDecision?.provenance?.projection?.projectionId).toBe(projection);
    expect(trace.effectiveModelDecision?.target).toMatchObject({ accessProviderId: "cline", physicalModelId: "gpt-5.6-terra" });
    expect(trace.effectiveModelDecision?.reasons?.map((reason) => reason.code)).toContain("projection-reverse-mapped");

    // A stale/foreign projection id is never silently remapped — it fails
    // closed with an actionable model-unavailable error at the projection
    // dispatch boundary (the session universe is the only authority).
    const foreign = await sendModel(token, "claude-rly-cline-zzz999");
    expect(foreign.statusCode).toBe(400);
    const body = foreign.json() as { error?: { type?: string } };
    expect(body.error?.type).toBe("model-unavailable");
  });

  it("records persisted-view state for the owning profile only and never leaks another profile's model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-model-decision-view-iso-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(sseFixture("model-decision-view", "VIEW_OK"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    const seeded = await openApp(directory, endpoint, {
      modelRoles: { primary: "gpt-5.6-terra" },
      experimentalModels: true,
    });
    void seeded;
    // The session's view id derives from the immutable profile id (#126);
    // write RLY-owned persisted state into the REAL owning view.
    const policy = store?.currentPolicy();
    const profileA = policy?.snapshot.profiles[0];
    if (!store || !profileA) throw new Error("missing profile");
    const viewA = deriveClaudeViewId(profileA.id);
    const projectionA = projectionIdFor("cline", "gpt-5.6-terra");
    const viewADirectory = join(directory, "claude", "views", viewA);
    await mkdir(viewADirectory, { recursive: true });
    await writeFile(
      join(viewADirectory, "settings.json"),
      JSON.stringify({ model: projectionA }),
      "utf8",
    );
    // A SECOND profile with its own derived view persists a DIFFERENT model —
    // another profile's state that must never silently influence profile A.
    const other = store.createProfile({
      name: "other",
      harness: "claude",
      providerId: profileA.providerId,
      poolId: profileA.poolId,
      modelRoles: { primary: "gpt-5.6-sol" },
    }, "cli");
    const viewB = deriveClaudeViewId(other.id);
    const viewBDirectory = join(directory, "claude", "views", viewB);
    await mkdir(viewBDirectory, { recursive: true });
    await writeFile(
      join(viewBDirectory, "settings.json"),
      JSON.stringify({ model: projectionIdFor("cline", "gpt-5.6-sol") }),
      "utf8",
    );
    const token = await issueToken();
    const solProjection = projectionIdFor("cline", "gpt-5.6-sol");

    // 1. The owning view's persisted projection is the source: the decision
    //    records persisted-view provenance (never silently remapped).
    const persisted = await sendModel(token, projectionA);
    expect(persisted.statusCode).toBe(200);
    let trace = await latestTrace(token);
    expect(trace.effectiveModelDecision?.provenance?.persistedViewModel).toBe(projectionA);
    expect(trace.effectiveModelDecision?.precedence?.winner).toBe("persisted-rly-view");
    expect(trace.effectiveModelDecision?.precedence?.conflicts ?? []).toHaveLength(0);
    // The OTHER profile's persisted model never appears anywhere in profile A's
    // first decision (no leakage, not even as routing metadata).
    expect(JSON.stringify(trace.effectiveModelDecision)).not.toContain(solProjection);

    // 2. A projection that differs from the owning view's persisted model is a
    //    visible conflict and resolves through the pinned universe only.
    const foreign = await sendModel(token, solProjection);
    expect(foreign.statusCode).toBe(200);
    trace = await latestTrace(token);
    expect(trace.effectiveModelDecision?.precedence?.winner).toBe("exact-projection");
    expect(trace.effectiveModelDecision?.precedence?.conflicts?.some(
      (conflict) => conflict.kind === "projection-vs-view-state",
    )).toBe(true);
    // Profile A's persisted-view state remains its OWN model even after a
    // foreign-projection request (never silently reassigned).
    expect(trace.effectiveModelDecision?.provenance?.persistedViewModel).toBe(projectionA);
  });

  it("keeps subagent decisions isolated: child intent wins, parent model is never mutated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-model-decision-subagent-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(sseFixture("model-decision-sub", "SUB_OK"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await openApp(directory, endpoint, { modelRoles: { primary: "gpt-5.6-terra" } });
    const token = await issueToken();
    const session = "claude-session-127";
    // Parent/main request freezes the parent context on Terra.
    const main = await sendModel(token, "gpt-5.6-terra", agentHeaders(session, "main-agent"));
    expect(main.statusCode).toBe(200);
    let trace = await latestTrace(token);
    expect(trace.effectiveModelDecision?.target?.physicalModelId).toBe("gpt-5.6-terra");
    // A subagent tier request (`fable`) inherits the parent's frozen family
    // context and resolves to the family-appropriate target (Sol) — the child
    // intent wins (visible conflict) and the parent is untouched.
    const child = await sendModel(token, "fable", agentHeaders(session, "child-agent", "main-agent"));
    expect(child.statusCode).toBe(200);
    trace = await latestTrace(token);
    expect(trace.effectiveModelDecision?.target?.physicalModelId).toBe("gpt-5.6-sol");
    expect(trace.effectiveModelDecision?.precedence?.winner).toBe("client-native-alias");
    expect(trace.effectiveModelDecision?.precedence?.conflicts?.some(
      (conflict) => conflict.kind === "subagent-request-vs-parent-context",
    )).toBe(true);
    expect(trace.effectiveModelDecision?.provenance?.inherit?.parentModelId).toBe("gpt-5.6-terra");
    expect(trace.effectiveModelDecision?.provenance?.inherit?.contextSource).toBe("parent-agent");
    // The parent/main execution context still resolves to Terra after the
    // child's decision (no mutation).
    if (agentContexts === undefined) throw new Error("missing agent contexts");
    const mainContext = agentContexts.resolve({
      profileId: "unused", profileName: "unused", leaseId: "00000000-0000-4000-8000-000000000323", viewId: "unused", modelUniverse: { policyRevision: 1, policyHash: "x".repeat(64), registryRevision: 5, bindings: [], experimentalModels: false },
      binding: {
        profile: { id: "unused", name: "unused", harness: "claude", modelRoles: {}, capabilityPolicy: undefined, launchPolicy: undefined },
        pool: { id: "pool-unused", name: "pool", providerId: "prov-unused", strategy: "fill-first", retryBudget: 0, affinity: undefined, memberships: [] },
        provider: { id: "prov-unused", name: "openrouter", integrationMode: "direct", endpointPolicy: undefined, enabled: true },
      },
    }, session, "main-agent");
    expect(mainContext?.resolvedModelId).toBe("gpt-5.6-terra");
    // A follow-up main request still resolves Terra.
    const again = await sendModel(token, "gpt-5.6-terra", agentHeaders(session, "main-agent"));
    expect(again.statusCode).toBe(200);
    trace = await latestTrace(token);
    expect(trace.effectiveModelDecision?.target?.physicalModelId).toBe("gpt-5.6-terra");
  });

  it("keeps every decision and trace secret-free (allowlisted metadata only)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-model-decision-privacy-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(sseFixture("model-decision-privacy", "PRIV_OK"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await openApp(directory, endpoint, {
      modelRoles: { primary: "gpt-5.6-terra" },
      environment: { ANTHROPIC_AUTH_TOKEN: "fixture-token", OPENAI_API_KEY: "fixture-key" },
    });
    const token = await issueToken();
    const response = await sendModel(token, "gpt-5.6-terra");
    expect(response.statusCode).toBe(200);
    const listed = await requireApp().inject({
      method: "GET",
      url: "/v1/route-traces",
      headers: { authorization: `Bearer ${token}` },
    });
    const body: unknown = listed.json();
    const traces = body && typeof body === "object" && "traces" in body && Array.isArray(body.traces) ? body.traces : [];
    const last = (traces as DecisionTraceShape[]).at(-1);
    // The DECISION object itself is allowlisted metadata: no credentials,
    // prompts, responses, reasoning text, or raw account identity. (The
    // account decision trace may carry a pseudonym by design.)
    const decisionSerialized = JSON.stringify(last?.effectiveModelDecision ?? {});
    expect(decisionSerialized).not.toMatch(/fixture-token|fixture-key|cline-access-token|refresh-token|authorization|prompt|response|@|acct-cline|accountPseudonym|credentialGeneration/i);
    // Full trace stays free of secrets and user content.
    const fullSerialized = JSON.stringify(listed.json());
    expect(fullSerialized).not.toMatch(/fixture-token|fixture-key|cline-access-token|refresh-token|prompt|@/i);
  });
});
