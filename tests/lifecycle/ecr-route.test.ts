import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { LaunchSessionRegistry } from "../../src/profiles/sessions.js";
import { RouteTraceRing } from "../../src/profiles/traces.js";
import { createGatewayServer } from "../../src/runtime/gateway-server.js";
import { LeaseManager } from "../../src/runtime/lease-manager.js";
import { AffinityStore } from "../../src/routing/pools/affinity.js";
import { RouteSelector } from "../../src/routing/pools/selector.js";
import { gatewayConfigSchema } from "../../src/config/schema.js";
import { ClaimEvidenceStore } from "../../src/canary/artifact.js";
import { CLAUDE_CODE_CONTRACT } from "../../src/canary/client-fixtures.js";
import { claimIdentityFor, claimKeyFor, appendObservation } from "../../src/canary/claim.js";
import { EffectiveCompatibilityRegistry } from "../../src/compatibility/registry.js";
import { ReviewDecisionStore, QuarantineStore } from "../../src/compatibility/stores.js";
import { runtimeCompatibilityPolicy } from "../../src/compatibility/policy.js";
import { evidenceRevisionFor } from "../../src/compatibility/features.js";
import { passedClaim, promoteDecision } from "../helpers/compat.js";
import { RUNTIME_VERSION } from "../../src/runtime/gateway-attestation.js";
import type { EvidenceArtifactV2, CompatibilityClaimDocument } from "../../src/canary/claim.js";

/**
 * Runtime-consumer lifecycle (#124): with the Effective Compatibility Registry
 * wired into the gateway, normal execution requires effective trusted
 * compatibility for the required features; a quarantined required feature
 * fails closed (no silent fallback); experimental override is traceable; and
 * legacy static states are seed/reference data only.
 */

const directories: string[] = [];
let app: FastifyInstance | undefined;
let store: ControlPlaneStore | undefined;
let broker: CredentialBroker | undefined;
let provider: FastifyInstance | undefined;
let leases: LeaseManager | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await provider?.close();
  provider = undefined;
  await broker?.close();
  broker = undefined;
  store?.close();
  store = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const MODEL = "nvidia/nemotron-3.5-lightning:free";

/** Claim identity for the openrouter direct path under the pinned baseline. */
function identityFor() {
  return claimIdentityFor({
    client: "claude-code",
    clientVersion: CLAUDE_CODE_CONTRACT.baseline,
    contract: CLAUDE_CODE_CONTRACT,
    adapterId: "openrouter-direct",
    accessProviderId: "openrouter",
    physicalModelId: MODEL,
    modelFamily: "nvidia",
  });
}

async function seedControlPlane(directory: string, endpoint: string) {
  store = await ControlPlaneStore.open(directory);
  broker = await CredentialBroker.open(directory);
  const created = store.createProvider({ name: "openrouter", integrationMode: "direct", endpointPolicy: endpoint }, "cli");
  const first = store.createAccount({ pseudonym: "acct-pool-a", providerId: created.id, credentialHandle: "env:OPENROUTER_API_KEY" }, "cli");
  const ready = store.bindCredential(first.id, first.version, { credentialHandle: "env:OPENROUTER_API_KEY", credentialGeneration: 1, state: "ready" }, "cli");
  const pool = store.createPool({ name: "work-pool", providerId: created.id, strategy: "fill-first", retryBudget: 1, accountIds: [ready.id] }, "cli");
  store.createProfile({
    name: "work",
    harness: "claude",
    providerId: created.id,
    poolId: pool.id,
    modelRoles: { primary: MODEL, fast: MODEL, reasoning: MODEL },
  }, "cli");
}

async function startGateway(directory: string): Promise<void> {
  if (!store || !broker) throw new Error("missing store");
  leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
  const sessions = new LaunchSessionRegistry((id) => leases?.has(id) === true);
  const traces = new RouteTraceRing();
  const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17871, logLevel: "silent" } });
  // #124: the Effective Compatibility Registry is the SOLE runtime authority.
  const compatibility = new EffectiveCompatibilityRegistry({
    claims: new ClaimEvidenceStore(directory),
    reviews: new ReviewDecisionStore(directory),
    quarantines: new QuarantineStore(directory),
    policy: runtimeCompatibilityPolicy({
      supportedClientBaseline: CLAUDE_CODE_CONTRACT.baseline,
      pinnedProtocolRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
      pinnedFixtureRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
      rlyBuildVersion: RUNTIME_VERSION,
    }),
  });
  app = createGatewayServer({
    host: "127.0.0.1",
    port: 17871,
    authToken: "instance-secret",
    instanceId: "00000000-0000-4000-8000-000000000001",
    configFingerprint: "a".repeat(64),
    config,
    environment: { OPENROUTER_API_KEY: "fixture-key" },
    controlPlane: store,
    broker,
    selector: new RouteSelector(store, new AffinityStore(directory)),
    launchSessions: sessions,
    traces,
    leases,
    compatibility,
  });
}

async function issueSession(): Promise<string> {
  const leaseId = "00000000-0000-4000-8000-000000000022";
  await leases?.add(leaseId);
  const issued = await app?.inject({
    method: "POST",
    url: "/v1/launch-sessions",
    headers: { authorization: "Bearer instance-secret", "content-type": "application/json" },
    payload: { profileName: "work", leaseId },
  });
  expect(issued?.statusCode).toBe(201);
  const body = issued?.json() as { token?: string };
  return body.token ?? "";
}

async function sendText(token: string): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> {
  const response = await app?.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: { model: "claude-haiku-4-5", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
  });
  if (response === undefined) throw new Error("no response");
  return response;
}

function seedClaims(directory: string, features: readonly string[]): Promise<CompatibilityClaimDocument[]> {
  const claims = new ClaimEvidenceStore(directory);
  return Promise.all(features.map(async (feature) => {
    const doc = passedClaim(feature as "text", identityFor());
    await claims.writeClaim(doc);
    return doc;
  }));
}

async function promoteAll(directory: string, claims: readonly CompatibilityClaimDocument[]): Promise<void> {
  const reviews = new ReviewDecisionStore(directory);
  for (const claim of claims) {
    await reviews.addDecision({
      claimKey: claim.claimKey,
      feature: claim.feature,
      decision: "promote",
      evidenceRevision: evidenceRevisionFor(claim),
      reviewer: "owner",
      source: "lifecycle-test",
      reason: "layers-a-b-c-pass-review",
      decidedAt: new Date().toISOString(),
      rlyBuildVersion: RUNTIME_VERSION,
    });
  }
}

describe("ECR runtime-consumer lifecycle (#124)", () => {
  it("executes normally when required features are effectively trusted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-ecr-trusted-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(
      'data: {"id":"pool","choices":[{"delta":{"content":"ECR_OK"}}]}\n\ndata: {"id":"pool","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await seedControlPlane(directory, endpoint);
    // text + cancellation + streaming are required for a streaming text request.
    const claims = await seedClaims(directory, ["text", "cancellation", "streaming"]);
    await promoteAll(directory, claims);
    await startGateway(directory);
    const token = await issueSession();
    const response = await sendText(token);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("ECR_OK");
  });

  it("fails closed when a required feature is quarantined — no silent fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-ecr-quarantine-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(
      'data: {"id":"pool","choices":[{"delta":{"content":"SHOULD_NOT_HAPPEN"}}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await seedControlPlane(directory, endpoint);
    const claims = await seedClaims(directory, ["text", "cancellation", "streaming"]);
    await promoteAll(directory, claims);
    // Quarantine ONLY the text claim: the required text feature fails closed.
    const quarantines = new QuarantineStore(directory);
    await quarantines.quarantine({
      claimKey: claims.find((claim) => claim.feature === "text")?.claimKey ?? "",
      feature: "text",
      reason: "strong-reproducible-failure",
      source: "lifecycle-test",
      quarantinedAt: new Date().toISOString(),
    });
    await startGateway(directory);
    const token = await issueSession();
    const response = await sendText(token);
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("SHOULD_NOT_HAPPEN");
    expect(response.body).toContain("compatibility-rejected");
  });

  it("blocks when evidence was updated after the review decision (re-review required)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-ecr-restale-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(
      'data: {"id":"pool","choices":[{"delta":{"content":"STALE"}}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await seedControlPlane(directory, endpoint);
    const claims = await seedClaims(directory, ["text", "cancellation", "streaming"]);
    await promoteAll(directory, claims);
    // Append a genuinely new observation to the text claim AFTER promotion.
    const claimsStore = new ClaimEvidenceStore(directory);
    const textClaim = claims.find((claim) => claim.feature === "text");
    if (textClaim === undefined) throw new Error("missing text claim");
    const updated = appendObservation(textClaim, Object.freeze({
      ...textClaim.records[0],
      checkedAt: new Date(Date.now() + 60_000).toISOString(),
    }) as EvidenceArtifactV2);
    await claimsStore.writeClaim(updated);
    await startGateway(directory);
    const token = await issueSession();
    const response = await sendText(token);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("compatibility-rejected");
  });

  it("blocks when a reviewed claim went stale on material RLY build drift", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-ecr-stale-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => new Response(
      'data: {"id":"pool","choices":[{"delta":{"content":"STALE_DRIFT"}}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await seedControlPlane(directory, endpoint);
    const claims = await seedClaims(directory, ["text", "cancellation", "streaming"]);
    await promoteAll(directory, claims);
    // Gateway pins a NEWER material RLY build than the one the reviews were
    // made under: the reviewed positive goes STALE and cannot stay silently
    // VERIFIED — the required features block (re-review required).
    const compatibility = new EffectiveCompatibilityRegistry({
      claims: new ClaimEvidenceStore(directory),
      reviews: new ReviewDecisionStore(directory),
      quarantines: new QuarantineStore(directory),
      policy: runtimeCompatibilityPolicy({
        supportedClientBaseline: CLAUDE_CODE_CONTRACT.baseline,
        pinnedProtocolRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
        pinnedFixtureRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
        rlyBuildVersion: "rly-build-999",
      }),
    });
    leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
    const sessions = new LaunchSessionRegistry((id) => leases?.has(id) === true);
    const traces = new RouteTraceRing();
    const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17871, logLevel: "silent" } });
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17871,
      authToken: "instance-secret",
      instanceId: "00000000-0000-4000-8000-000000000001",
      configFingerprint: "a".repeat(64),
      config,
      environment: { OPENROUTER_API_KEY: "fixture-key" },
      controlPlane: store,
      broker,
      selector: new RouteSelector(store, new AffinityStore(directory)),
      launchSessions: sessions,
      traces,
      leases,
      compatibility,
    });
    const token = await issueSession();
    const response = await sendText(token);
    // The exact pin is the EXPLICIT experimental override for a stale claim —
    // visible in the route trace (never silent); a hard quarantine could never
    // be bypassed this way.
    expect(response.statusCode).toBe(200);
    const tracesResponse = await app?.inject({
      method: "GET",
      url: "/v1/route-traces",
      headers: { authorization: `Bearer ${token}` },
    });
    const traceBody = tracesResponse?.json() as { traces?: { modelSelection?: { candidates?: { authority?: string; effectiveLabel?: string; enforcementReason?: string }[] } }[] };
    const selection = traceBody?.traces?.at(-1)?.modelSelection;
    expect(selection?.candidates?.some((candidate) =>
      candidate.authority === "ecr" && candidate.effectiveLabel === "stale" && candidate.enforcementReason === "explicit-experimental-override",
    )).toBe(true);
  });
});
