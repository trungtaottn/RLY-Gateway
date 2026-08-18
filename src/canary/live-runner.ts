import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createGatewayServer } from "../runtime/gateway-server.js";
import { closeGatewayBounded } from "../runtime/owned-gateway.js";
import { ControlPlaneStore } from "../control-plane/store.js";
import { LaunchSessionRegistry } from "../profiles/sessions.js";
import { appendObservation, claimIdentityFor, claimKeyFor, emptyClaimDocument, type CompatibilityClaimDocument, type EvidenceArtifactV2 } from "./claim.js";
import { CLAUDE_CODE_CONTRACT, CODEX_CLI_CONTRACT, type ClientContract } from "./client-fixtures.js";
import {
  LIVE_ACCESS_FIXTURE_REVISION,
  LIVE_ACCESS_PATH_RUNNER_VERSION,
  LIVE_ACCESS_GATES,
  type CompatFailureCategory,
  type LiveAccessPathSpec,
  type LiveAccessPathSummary,
  type RunnerGateObservation,
} from "./runner-types.js";
import type { EndpointContract } from "./types.js";
import type { ClaimFeature } from "./claim.js";

/**
 * Layer C — exact access-path live runner (#123).
 *
 * Executes ONE selected exact claim path — client + client version +
 * protocol/revision + adapter/integration + access provider + auth mode +
 * endpoint contract + physical model + feature gate — through the real RLY
 * gateway translation stack (Anthropic Messages / OpenAI Responses surface →
 * direct adapter → the configured provider endpoint) using an explicit opt-in
 * credential from the environment. Emits feature-scoped Evidence Artifact v2
 * records (layer C, kind `live-access-path`); text success can never promote
 * tools/reasoning/discovery claims because each gate carries its own request
 * and its own evidence record.
 *
 * Hard invariants:
 * - Runs ONLY on explicit opt-in (`RLY_LIVE_CANARY=1` at the CLI boundary)
 *   with an available credential; a missing credential or skipped run emits
 *   `not-run` (`authentication-credentials-unavailable`), never PASS.
 * - The credential is read from the environment and never stored, logged, or
 *   included in artifacts; requests use synthetic low-impact canary payloads.
 * - Results are typed/redacted (`authentication-failure`,
 *   `provider-rate-limit`, `provider-unavailable`, `unsupported-feature`,
 *   `malformed-continuation`, `timeout-cancel-failure`,
 *   `protocol-translation-failure`, `environment-inability`).
 * - Same upstream model through two access providers produces distinct claim
 *   keys; evidence never crosses providers.
 * - The runner never mutates trusted registry / effective compatibility state.
 */

/** Synthetic instance bearer used only for the in-process gateway listener. */
const RUNNER_INSTANCE_TOKEN = "fixture-live-runner-token";
const DEFAULT_LIVE_TIMEOUT_MS = 60_000;
const STREAM_ABORT_GRACE_MS = 2_000;

function observation(gate: ClaimFeature, result: RunnerGateObservation["result"], failureReason?: CompatFailureCategory, detail?: string, timingMs?: number): RunnerGateObservation {
  return Object.freeze({
    gate, result,
    ...(failureReason === undefined ? {} : { failureReason }),
    ...(detail === undefined ? {} : { detail }),
    ...(timingMs === undefined ? {} : { timingMs }),
  });
}

/** Synthetic, low-impact canary payloads (never real prompts or content). */
function canaryTextPrompt(): string {
  return "Reply with the single word OK.";
}

function canaryToolPrompt(): string {
  return "Use the Bash tool once, then reply OK.";
}

function canaryToolDefinitions(parallel = false): readonly Readonly<Record<string, unknown>>[] {
  const bash = Object.freeze({ name: "Bash", description: "synthetic canary tool", input_schema: { type: "object", properties: { command: { type: "string" } } } });
  if (!parallel) return Object.freeze([bash]);
  const grep = Object.freeze({ name: "Grep", description: "synthetic canary tool", input_schema: { type: "object", properties: { pattern: { type: "string" } } } });
  return Object.freeze([bash, grep]);
}

function anthropicBody(feature: ClaimFeature, model: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    model,
    max_tokens: 64,
    messages: [{ role: "user", content: canaryTextPrompt() }],
  };
  switch (feature) {
    case "streaming":
    case "cancellation":
      return { ...base, stream: true };
    case "tools-single":
    case "tools-multi":
    case "tools-parallel":
      return {
        ...base,
        messages: [{ role: "user", content: canaryToolPrompt() }],
        tools: canaryToolDefinitions(feature === "tools-parallel"),
      };
    case "reasoning":
    case "reasoning-tools":
      return {
        ...base,
        thinking: { type: "enabled" },
        ...(feature === "reasoning-tools"
          ? {
              messages: [{ role: "user", content: canaryToolPrompt() }],
              tools: canaryToolDefinitions(),
            }
          : {}),
      };
    case "effort-signal":
      return { ...base, thinking: { type: "enabled" }, effort: "high" };
    case "session-attribution":
      return base;
    default:
      return base;
  }
}

function responsesBody(feature: ClaimFeature, model: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    model,
    input: canaryTextPrompt(),
  };
  switch (feature) {
    case "streaming":
    case "cancellation":
      return { ...base, stream: true };
    case "tools-single":
    case "tools-multi":
    case "tools-parallel":
      return {
        ...base,
        input: canaryToolPrompt(),
        tools: (feature === "tools-parallel"
          ? [
              { type: "function", name: "Bash", description: "synthetic canary tool", parameters: { type: "object", properties: { command: { type: "string" } } } },
              { type: "function", name: "Grep", description: "synthetic canary tool", parameters: { type: "object", properties: { pattern: { type: "string" } } } },
            ]
          : [{ type: "function", name: "Bash", description: "synthetic canary tool", parameters: { type: "object", properties: { command: { type: "string" } } } }]),
      };
    case "reasoning":
    case "reasoning-tools":
      return {
        ...base,
        reasoning: { effort: "medium" },
        ...(feature === "reasoning-tools"
          ? {
              input: canaryToolPrompt(),
              tools: [{ type: "function", name: "Bash", description: "synthetic canary tool", parameters: { type: "object", properties: { command: { type: "string" } } } }],
            }
          : {}),
      };
    case "effort-signal":
      return { ...base, reasoning: { effort: "high" } };
    default:
      return base;
  }
}

function syntheticAttributionHeaders(): Readonly<Record<string, string>> {
  return {
    "x-claude-code-session-id": "session-canary-0001",
    "x-claude-code-agent-id": "agent-canary-0001",
    "x-claude-code-parent-agent-id": "parent-canary-0001",
  };
}

type LiveGateOutcome = Readonly<{
  httpStatus: number;
  body: string;
  timingMs: number;
  aborted?: boolean;
  firstEvent?: boolean;
  errorType?: string;
}>;

async function requestLivePath(
  baseUrl: string,
  token: string,
  endpoint: EndpointContract,
  feature: ClaimFeature,
  model: string,
  timeoutMs: number,
  abortAfterFirstEvent: boolean,
): Promise<LiveGateOutcome> {
  const started = Date.now();
  const path = endpoint === "anthropic-messages" ? "/v1/messages" : "/v1/responses";
  const body = endpoint === "anthropic-messages" ? anthropicBody(feature, model) : responsesBody(feature, model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("live path timeout")), timeoutMs);
  const post = async (payload: Record<string, unknown>): Promise<Readonly<{ status: number; text: string }>> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...syntheticAttributionHeaders(),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    return Object.freeze({ status: response.status, text });
  };
  try {
    let firstEvent = false;
    if (abortAfterFirstEvent) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...syntheticAttributionHeaders() },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.body === null) {
        return Object.freeze({ httpStatus: response.status, body: "", timingMs: Date.now() - started, errorType: "no-stream-body" });
      }
      const reader = response.body.getReader();
      const first = await reader.read();
      const firstValue = first.value instanceof Uint8Array ? first.value : undefined;
      if (firstValue !== undefined && firstValue.byteLength > 0) firstEvent = true;
      reader.releaseLock();
      // Abort after the first upstream event to exercise client cancellation.
      controller.abort(new Error("live canary cancellation"));
      await new Promise((resolve) => setTimeout(resolve, STREAM_ABORT_GRACE_MS));
      return Object.freeze({
        httpStatus: response.status,
        body: "",
        timingMs: Date.now() - started,
        aborted: true,
        firstEvent,
        ...(firstEvent ? {} : { errorType: "no-first-event" }),
      });
    }
    // Tools-multi / tools-parallel prove the tool-continuation path live: a
    // first tool-carrying request, then (only when the provider actually
    // returns tool calls) a follow-up request carrying the tool results.
    if (feature === "tools-multi" || feature === "tools-parallel") {
      const first = await post(body);
      if (first.status !== 200) {
        const firstErrorType = errorTypeOf(first.text);
        return Object.freeze({
          httpStatus: first.status,
          body: first.text.slice(0, 4_096),
          timingMs: Date.now() - started,
          ...(firstErrorType === undefined ? {} : { errorType: firstErrorType }),
        });
      }
      const toolUses = toolUsesFromAnthropic(first.text);
      const required = feature === "tools-parallel" ? 2 : 1;
      if (toolUses.length < required) {
        // The path carried the tool request but the model chose not to call
        // tools — continuation was not exercised. Not-run, never PASS.
        return Object.freeze({ httpStatus: 200, body: "", timingMs: Date.now() - started, errorType: "provider-did-not-call-tool" });
      }
      const continuation = anthropicContinuationBody(model, toolUses);
      const second = await post(continuation);
      const secondErrorType = errorTypeOf(second.text);
      return Object.freeze({
        httpStatus: second.status,
        body: second.text.slice(0, 4_096),
        timingMs: Date.now() - started,
        ...(secondErrorType === undefined ? {} : { errorType: secondErrorType }),
      });
    }
    const response = await post(body);
    const responseErrorType = errorTypeOf(response.text);
    return Object.freeze({
      httpStatus: response.status,
      body: response.text.slice(0, 4_096),
      timingMs: Date.now() - started,
      ...(responseErrorType === undefined ? {} : { errorType: responseErrorType }),
    });
  } finally {
    clearTimeout(timer);
  }
}

function errorTypeOf(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: { type?: unknown } };
    if (typeof parsed.error?.type === "string") return parsed.error.type;
  } catch {
    // SSE/plain text payloads carry no error envelope.
  }
  return undefined;
}

/** Extracts `tool_use` blocks from an aggregate Anthropic Messages response. */
function toolUsesFromAnthropic(text: string): readonly Readonly<{ id: string; input: unknown }>[] {
  try {
    const parsed = JSON.parse(text) as { content?: readonly unknown[] };
    if (!Array.isArray(parsed.content)) return Object.freeze([]);
    return Object.freeze(parsed.content.flatMap((block) => {
      if (typeof block !== "object" || block === null) return [];
      const candidate = block as { type?: unknown; id?: unknown; input?: unknown };
      if (candidate.type !== "tool_use" || typeof candidate.id !== "string") return [];
      return [Object.freeze({ id: candidate.id, input: candidate.input })];
    }));
  } catch {
    return Object.freeze([]);
  }
}

/** Builds a Messages continuation request carrying tool results. */
function anthropicContinuationBody(model: string, toolUses: readonly Readonly<{ id: string; input: unknown }>[]): Record<string, unknown> {
  return {
    model,
    max_tokens: 64,
    messages: [
      { role: "user", content: canaryToolPrompt() },
      { role: "assistant", content: toolUses.map((toolUse) => ({ type: "tool_use", id: toolUse.id, name: "Bash", input: toolUse.input })) },
      { role: "user", content: toolUses.map((toolUse) => ({ type: "tool_result", tool_use_id: toolUse.id, content: "fixture tool output" })) },
    ],
  };
}

/** Exercises the policy-driven `/v1/models` discovery surface (Layer C). */
async function requestLiveDiscovery(
  baseUrl: string,
  token: string,
  timeoutMs: number,
  accessProviderId: string,
): Promise<LiveGateOutcome> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("live discovery timeout")), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const text = await response.text();
    let errorType: string | undefined;
    let discoveryOk = false;
    try {
      const parsed = JSON.parse(text) as { error?: { type?: unknown }; data?: readonly unknown[] };
      if (typeof parsed.error?.type === "string") errorType = parsed.error.type;
      const slug = accessProviderId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const ids = Array.isArray(parsed.data) ? parsed.data.map((item) => (item as { id?: unknown }).id).filter((id): id is string => typeof id === "string") : [];
      discoveryOk = response.ok && ids.some((id) => id.startsWith(`claude-rly-${slug}-`));
    } catch {
      // Non-JSON discovery payloads are evaluated by status only.
    }
    return Object.freeze({
      httpStatus: response.status,
      body: discoveryOk ? "discovery-ok" : text.slice(0, 4_096),
      timingMs: Date.now() - started,
      ...(errorType === undefined ? {} : { errorType }),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Maps a gateway/provider response to a typed gate observation. */
function classifyGate(
  gate: ClaimFeature,
  outcome: LiveGateOutcome,
): RunnerGateObservation {
  if (outcome.errorType === "provider-did-not-call-tool") {
    return observation(gate, "not-run", "provider-did-not-call-tool", "provider accepted the tool request but did not call a tool; continuation not exercised", outcome.timingMs);
  }
  if (outcome.httpStatus === 401 || outcome.httpStatus === 403) {
    return observation(gate, "failed", "authentication-failure", `provider rejected the credential (${String(outcome.httpStatus)})`, outcome.timingMs);
  }
  if (outcome.httpStatus === 429) {
    return observation(gate, "failed", "provider-rate-limit", "provider returned rate limit", outcome.timingMs);
  }
  if (outcome.httpStatus === 404) {
    return observation(gate, "failed", "provider-unavailable", "provider endpoint or model not found", outcome.timingMs);
  }
  if (outcome.httpStatus === 400 && outcome.errorType === "unsupported-fidelity") {
    return observation(gate, "failed", "protocol-translation-failure", "fidelity envelope unsupported on this path", outcome.timingMs);
  }
  if (outcome.httpStatus === 400) {
    return observation(gate, "failed", "protocol-translation-failure", "request rejected by the access path", outcome.timingMs);
  }
  if (outcome.httpStatus === 503) {
    return observation(gate, "failed", "provider-unavailable", "no eligible account or provider unavailable", outcome.timingMs);
  }
  if (outcome.httpStatus === 502) {
    return observation(gate, "failed", "provider-unavailable", "provider gateway failure", outcome.timingMs);
  }
  if (outcome.aborted === true) {
    if (gate === "cancellation" && outcome.firstEvent === true) {
      return observation(gate, "passed", undefined, undefined, outcome.timingMs);
    }
    return observation(gate, "failed", "timeout-cancel-failure", "request aborted before completion", outcome.timingMs);
  }
  if (outcome.httpStatus !== 200) {
    return observation(gate, "failed", "provider-unavailable", `unexpected provider status (${String(outcome.httpStatus)})`, outcome.timingMs);
  }
  // HTTP 200: the exact access path carried this feature. The response body
  // is never stored; the raw machine-readable result records only the status
  // and a typed summary.
  const okBody = outcome.body.length > 0;
  if (!okBody) {
    return observation(gate, "failed", "protocol-translation-failure", "empty response from the access path", outcome.timingMs);
  }
  if (gate === "model-discovery" && outcome.body !== "discovery-ok") {
    return observation(gate, "failed", "provider-unavailable", "exact-path discovery returned no projected models", outcome.timingMs);
  }
  return observation(gate, "passed", undefined, undefined, outcome.timingMs);
}

function buildGateway(spec: LiveAccessPathSpec, environment: NodeJS.ProcessEnv): Promise<Readonly<{ app: FastifyInstance; cleanup: () => Promise<void> }>> {
  const config = {
    schemaVersion: 1 as const,
    gateway: {
      host: "127.0.0.1" as const,
      port: 0,
      managementPort: 0,
      logLevel: "silent" as const,
      modelDiscovery: { experimentalModels: true },
    },
    controlPlane: {},
    routes: {
      primary: {
        provider: spec.accessProviderId,
        model: spec.physicalModelId,
        credential: `env:${spec.credentialEnvName}`,
        baseUrl: spec.providerBaseUrl,
      },
    },
  };
  return (async () => {
    // A minimal control-plane policy binds the exact access path so the
    // gateway serves a policy-driven `/v1/models` universe for it (#72). The
    // store lives in a throwaway temp directory and is closed/removed after
    // the run; it never touches the real control plane.
    const directory = await mkdtemp(join(tmpdir(), "rly-live-runner-cp-"));
    const controlPlane = await ControlPlaneStore.open(directory);
    const actor = "system" as const;
    const provider = controlPlane.createProvider({ name: spec.accessProviderId, integrationMode: "direct" }, actor);
    const account = controlPlane.createAccount({ pseudonym: "runner-account", providerId: provider.id, credentialHandle: "cred-runner", state: "ready" }, actor);
    const pool = controlPlane.createPool({ name: "runner-pool", providerId: provider.id, strategy: "round-robin", accountIds: [account.id] }, actor);
    controlPlane.createProfile({ name: "runner-profile", harness: "claude", providerId: provider.id, poolId: pool.id, modelRoles: { primary: spec.physicalModelId } }, actor);
    const app = createGatewayServer({
      host: "127.0.0.1",
      port: 0,
      authToken: RUNNER_INSTANCE_TOKEN,
      instanceId: randomUUID(),
      configFingerprint: createHash("sha256").update(spec.providerBaseUrl).digest("hex"),
      config,
      environment,
      controlPlane,
      launchSessions: new LaunchSessionRegistry(),
    });
    return Object.freeze({
      app,
      cleanup: async (): Promise<void> => {
        controlPlane.close();
        await rm(directory, { recursive: true, force: true });
      },
    });
  })();
}

/** Executes the live access-path matrix for one exact claim path. */
export async function runLiveAccessPath(spec: LiveAccessPathSpec): Promise<LiveAccessPathSummary> {
  const environment = spec.environment ?? process.env;
  const credential = environment[spec.credentialEnvName];
  const gates = spec.gates ?? LIVE_ACCESS_GATES;
  const now = spec.now ?? (() => new Date().toISOString());
  const envMeta = Object.freeze({
    platform: spec.platform?.platform ?? process.platform,
    nodeVersion: spec.platform?.nodeVersion ?? process.version,
  });
  const fixtureRevision = spec.fixtureRevision ?? LIVE_ACCESS_FIXTURE_REVISION;
  const contract: ClientContract = spec.client === "claude-code" ? CLAUDE_CODE_CONTRACT : CODEX_CLI_CONTRACT;
  const claimIdentity = claimIdentityFor({
    client: spec.client,
    clientVersion: spec.clientVersion,
    contract,
    adapterId: spec.adapterId,
    accessProviderId: spec.accessProviderId,
    physicalModelId: spec.physicalModelId,
  });

  const buildRecords = (observations: readonly RunnerGateObservation[]): Readonly<{
    evidence: readonly EvidenceArtifactV2[];
    claims: readonly CompatibilityClaimDocument[];
  }> => {
    const evidence: EvidenceArtifactV2[] = [];
    const claimsByKey = new Map<string, CompatibilityClaimDocument>();
    for (const gateObservation of observations) {
      const claimKey = claimKeyFor(claimIdentity, gateObservation.gate);
      const record: EvidenceArtifactV2 = Object.freeze({
        claimKey,
        feature: gateObservation.gate,
        layer: "C",
        kind: "live-access-path",
        fixtureRevision,
        runnerVersion: LIVE_ACCESS_PATH_RUNNER_VERSION,
        checkedAt: now(),
        result: gateObservation.result,
        ...(gateObservation.failureReason === undefined ? {} : { failureReason: gateObservation.failureReason }),
        environment: envMeta,
        ...(gateObservation.timingMs === undefined ? {} : { timingMs: gateObservation.timingMs }),
      });
      evidence.push(record);
      const existing = claimsByKey.get(claimKey) ?? emptyClaimDocument(claimIdentity, gateObservation.gate);
      claimsByKey.set(claimKey, appendObservation(existing, record));
    }
    return Object.freeze({ evidence: Object.freeze(evidence), claims: Object.freeze([...claimsByKey.values()]) });
  };

  // Missing credentials / skipped runs: every gate is `not-run`, never PASS.
  if (credential === undefined || credential.trim() === "") {
    const observations = gates.map((gate) => observation(gate, "not-run", "authentication-credentials-unavailable", `credential env ${spec.credentialEnvName} is unset`));
    const { evidence, claims } = buildRecords(observations);
    return Object.freeze({
      claimIdentity,
      gates: Object.freeze(observations),
      evidence,
      claims,
      environment: envMeta,
      error: "authentication-credentials-unavailable",
    });
  }

  const built = await buildGateway(spec, environment);
  const app = built.app;
  try {
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const timeoutMs = spec.timeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS;
    const observations: RunnerGateObservation[] = [];
    for (const gate of gates) {
      let outcome: LiveGateOutcome;
      try {
        outcome = gate === "model-discovery"
          ? await requestLiveDiscovery(baseUrl, RUNNER_INSTANCE_TOKEN, timeoutMs, spec.accessProviderId)
          : await requestLivePath(baseUrl, RUNNER_INSTANCE_TOKEN, spec.endpointContract, gate, spec.physicalModelId, timeoutMs, gate === "cancellation");
      } catch {
        outcome = Object.freeze({ httpStatus: 0, body: "", timingMs: 0, errorType: "request-failed" });
      }
      observations.push(classifyGate(gate, outcome));
    }
    const { evidence, claims } = buildRecords(observations);
    return Object.freeze({
      claimIdentity,
      gates: Object.freeze(observations),
      evidence,
      claims,
      environment: envMeta,
    });
  } finally {
    await closeGatewayBounded({ close: () => app.close(), server: app.server });
    await built.cleanup();
  }
}

/** Live-exercisable gates for one client surface (exported for tests/CLI). */
export function liveGatesFor(): readonly ClaimFeature[] {
  return LIVE_ACCESS_GATES;
}
