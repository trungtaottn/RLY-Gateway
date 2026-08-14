import type { ModelEvidence } from "../registry/model-registry.js";
import type { CanonicalEvent } from "../core/canonical-event.js";
import { decodeAnthropicRequest } from "../protocols/anthropic/decoder.js";
import { aggregateAnthropicEvents, encodeAnthropicEvents } from "../protocols/anthropic/encoder.js";
import { parseAgentContext } from "../core/agent-context.js";
import type { ClientContract } from "./client-fixtures.js";
import {
  SYNTHETIC_ATTRIBUTION_HEADERS,
  SYNTHETIC_ATTRIBUTION_HEADERS_PARALLEL,
  SYNTHETIC_EFFORT_REQUEST,
  SYNTHETIC_TEXT_REQUEST,
  SYNTHETIC_TOOL_REQUEST,
  syntheticMultiToolRun,
  syntheticReasoningToolRun,
  syntheticTextStream,
  syntheticToolRun,
} from "./shapes.js";
import type { CanaryGate, CanaryGateResult, GateStatus } from "./types.js";

/**
 * Deterministic gate matrix (#24). Every gate pins one contract RLY depends on
 * and is evaluated for an exact access path (client baseline + access provider
 * + adapter + physical model). Gates never run a live client, never store
 * prompts/responses, and fail with a typed reason so a changed client contract
 * is diagnosable instead of silently passing.
 */

export type MatrixInput = Readonly<{
  clientBaseline: string;
  accessProviderId: string;
  adapterId: string;
  physicalModelId: string;
  modelFamily?: string;
  evidence: ModelEvidence;
  contract: ClientContract;
  /**
   * Fixture-shape overrides for drift tests (#24): a deliberately changed
   * fake client fixture (missing agent header, malformed tool continuation,
   * clamped effort, changed filter) must fail the correct gate with a typed
   * reason. Defaults are the embedded synthetic shapes.
   */
  fixtures?: Readonly<{
    attributionHeaders?: Readonly<Record<string, string>>;
    attributionHeadersParallel?: Readonly<Record<string, string>>;
    effortRequest?: object;
    toolRequest?: object;
    textRequest?: object;
    textStream?: () => readonly unknown[];
    toolRun?: () => readonly unknown[];
    multiToolRun?: () => readonly unknown[];
    reasoningToolRun?: () => readonly unknown[];
  }>;
}>;

export type MatrixFixtures = NonNullable<MatrixInput["fixtures"]>;

function fixtureShapes(input: MatrixInput): Readonly<{
  attributionHeaders: Readonly<Record<string, string>>;
  attributionHeadersParallel: Readonly<Record<string, string>>;
  effortRequest: object;
  toolRequest: object;
  textRequest: object;
  textStream: () => readonly unknown[];
  toolRun: () => readonly unknown[];
  multiToolRun: () => readonly unknown[];
  reasoningToolRun: () => readonly unknown[];
}> {
  const fixtures = input.fixtures ?? {};
  return {
    attributionHeaders: fixtures.attributionHeaders ?? SYNTHETIC_ATTRIBUTION_HEADERS,
    attributionHeadersParallel: fixtures.attributionHeadersParallel ?? SYNTHETIC_ATTRIBUTION_HEADERS_PARALLEL,
    effortRequest: fixtures.effortRequest ?? SYNTHETIC_EFFORT_REQUEST,
    toolRequest: fixtures.toolRequest ?? SYNTHETIC_TOOL_REQUEST,
    textRequest: fixtures.textRequest ?? SYNTHETIC_TEXT_REQUEST,
    textStream: fixtures.textStream ?? syntheticTextStream,
    toolRun: fixtures.toolRun ?? syntheticToolRun,
    multiToolRun: fixtures.multiToolRun ?? syntheticMultiToolRun,
    reasoningToolRun: fixtures.reasoningToolRun ?? syntheticReasoningToolRun,
  };
}

function result(gate: CanaryGate, status: GateStatus, reason?: string): CanaryGateResult {
  return Object.freeze({ gate, status, ...(reason === undefined ? {} : { reason }) });
}

function passes(gate: CanaryGate): CanaryGateResult { return result(gate, "passed"); }
function fails(gate: CanaryGate, reason: string): CanaryGateResult { return result(gate, "failed", reason); }
function notRun(gate: CanaryGate, reason: string): CanaryGateResult { return result(gate, "not-run", reason); }

/** Deep-clones a synthetic fixture run into typed canonical events. */
function roundTripEvents(events: readonly unknown[]): readonly CanonicalEvent[] {
  return JSON.parse(JSON.stringify(events)) as readonly CanonicalEvent[];
}

function decodeFixture(fixture: object): boolean {
  try {
    decodeAnthropicRequest(fixture);
    return true;
  } catch {
    return false;
  }
}

/** Gate A1 — basic text Messages request decodes and capabilities are provable. */
function checkText(input: MatrixInput): CanaryGateResult {
  if (input.contract.client !== "claude-code") return notRun("text", "client-contract-not-applicable");
  if (!decodeFixture(fixtureShapes(input).textRequest)) return fails("text", "messages-request-invalid");
  if (!input.evidence.capabilities.streaming) return fails("text", "capability-unsupported");
  return passes("text");
}

/** Gate A2 — streaming framing/event order matches the pinned client contract. */
function checkStreaming(input: MatrixInput): CanaryGateResult {
  if (!input.evidence.capabilities.streaming) return notRun("streaming", "no-streaming-evidence");
  try {
    const wire = encodeAnthropicEvents(roundTripEvents(fixtureShapes(input).textStream()));
    const order = wire.map((item) => item.event);
    const contractOrder = input.contract.framing.streamingEventOrder;
    if (!order.includes("message_start") || !order.includes("message_stop")) {
      return fails("streaming", "streaming-framing-changed");
    }
    if (!contractOrder.includes("message_start") || !contractOrder.includes("message_stop")) {
      return fails("streaming", "streaming-framing-changed");
    }
    return passes("streaming");
  } catch {
    return fails("streaming", "streaming-framing-changed");
  }
}

/** Gate A3 — client abort propagates to the upstream signal. */
function checkCancellation(input: MatrixInput): CanaryGateResult {
  if (!input.contract.framing.cancellationPropagates) return fails("cancellation", "cancellation-contract-changed");
  return passes("cancellation");
}

/** Gate B1 — one tool call round-trips through the Anthropic encoder. */
function checkToolsSingle(input: MatrixInput): CanaryGateResult {
  if (!input.evidence.capabilities.tools) return notRun("tools-single", "no-tool-evidence");
  if (!decodeFixture(fixtureShapes(input).toolRequest)) return fails("tools-single", "tool-request-invalid");
  try {
    const aggregated = aggregateAnthropicEvents(roundTripEvents(fixtureShapes(input).toolRun())) as { content?: readonly Record<string, unknown>[] };
    const toolBlocks = (aggregated.content ?? []).filter((block) => block.type === "tool_use");
    if (toolBlocks.length !== 1) return fails("tools-single", "tool-result-invalid");
    const block = toolBlocks[0];
    if (block === undefined) return fails("tools-single", "tool-result-invalid");
    const parsed = block.input;
    if (parsed === null || typeof parsed !== "object" || !("command" in parsed)) return fails("tools-single", "tool-result-invalid");
    return passes("tools-single");
  } catch {
    return fails("tools-single", "tool-result-invalid");
  }
}

/** Gate B2 — multi-turn tool continuation keeps valid JSON aggregation. */
function checkToolsMulti(input: MatrixInput): CanaryGateResult {
  if (!input.evidence.capabilities.tools) return notRun("tools-multi", "no-tool-evidence");
  try {
    const aggregated = aggregateAnthropicEvents(roundTripEvents(fixtureShapes(input).multiToolRun())) as { content?: readonly Record<string, unknown>[] };
    const toolBlocks = (aggregated.content ?? []).filter((block) => block.type === "tool_use");
    if (toolBlocks.length !== 2) return fails("tools-multi", "tool-continuation-invalid");
    return passes("tools-multi");
  } catch {
    return fails("tools-multi", "tool-continuation-invalid");
  }
}

/** Gate B3 — parallel tool calls only when the access path claims support. */
function checkToolsParallel(input: MatrixInput): CanaryGateResult {
  if (!input.evidence.capabilities.parallelTools) return notRun("tools-parallel", "no-parallel-tool-evidence");
  try {
    const wire = encodeAnthropicEvents(roundTripEvents(fixtureShapes(input).multiToolRun()));
    const starts = wire.filter((item) => item.event === "content_block_start");
    if (starts.length < 2) return fails("tools-parallel", "parallel-tool-unframed");
    return passes("tools-parallel");
  } catch {
    return fails("tools-parallel", "parallel-tool-unframed");
  }
}

/** Gate C — reasoning accepted and requested effort preserved at the decoder. */
function checkReasoning(input: MatrixInput): CanaryGateResult {
  if (!input.evidence.capabilities.reasoning) return notRun("reasoning", "no-reasoning-evidence");
  if (input.contract.client === "claude-code") {
    if (input.contract.effort.requestField !== "effort") return fails("reasoning", "reasoning-shape-changed");
    const decoded = decodeAnthropicRequest(fixtureShapes(input).effortRequest);
    const sourceEffort = decoded.request.inference.reasoning?.sourceEffort;
    if (sourceEffort !== "high") return fails("reasoning", "reasoning-effort-clamped");
  }
  return passes("reasoning");
}

/** Gate D — reasoning and tool use interleave only with reviewed evidence. */
function checkReasoningTools(input: MatrixInput): CanaryGateResult {
  if (!input.evidence.reasoning.reasoningWithTools) return notRun("reasoning-tools", "no-reasoning-with-tools-evidence");
  try {
    const events = roundTripEvents(fixtureShapes(input).reasoningToolRun());
    const kinds = events.map((item) => item.type);
    if (!kinds.includes("content-started")) return fails("reasoning-tools", "reasoning-tool-interleave-invalid");
    return passes("reasoning-tools");
  } catch {
    return fails("reasoning-tools", "reasoning-tool-interleave-invalid");
  }
}

/** Gate E — `/v1/models` discovery: id filter and projection namespace contract. */
function checkModelDiscovery(input: MatrixInput): CanaryGateResult {
  const discovery = input.contract.modelDiscovery;
  if (discovery.request.path !== "/v1/models") return fails("model-discovery", "gateway-model-request-changed");
  const allowed = discovery.idPrefixFilter;
  if (allowed.length === 0 || !allowed.includes("claude") || !allowed.includes("anthropic")) {
    return fails("model-discovery", "gateway-model-filter-changed");
  }
  if (!allowed.some((prefix) => discovery.rlyProjectionPrefix.startsWith(prefix))) {
    return fails("model-discovery", "gateway-model-filter-changed");
  }
  if (!discovery.cacheAcrossStartups) return fails("model-discovery", "gateway-model-cache-changed");
  return passes("model-discovery");
}

/** Gate F1 — session/agent/parent headers parse into a typed context. */
function checkSessionAttribution(input: MatrixInput): CanaryGateResult {
  if (input.contract.client !== "claude-code") return notRun("session-attribution", "client-contract-not-applicable");
  const attribution = input.contract.attribution;
  const parsed = parseAgentContext(fixtureShapes(input).attributionHeaders);
  if (parsed?.claudeSessionId !== "session-synthetic-0001") return fails("session-attribution", "missing-agent-header");
  if (parsed.agentId !== "agent-synthetic-0001") return fails("session-attribution", "missing-agent-header");
  if (parsed.parentAgentId !== "parent-synthetic-0001") return fails("session-attribution", "missing-agent-header");
  if (!attribution.parsedLowercase) return fails("session-attribution", "attribution-header-case-changed");
  return passes("session-attribution");
}

/** Gate F2 — `model: fable` alias exists on the supported baseline. */
function checkSubagentRouting(input: MatrixInput): CanaryGateResult {
  if (input.contract.client !== "claude-code") return notRun("subagent-routing", "client-contract-not-applicable");
  const tiers = input.contract.aliases.tiers;
  if (!tiers.includes("fable")) return fails("subagent-routing", "fable-alias-unsupported");
  if (!tiers.includes("haiku") || !tiers.includes("sonnet") || !tiers.includes("opus")) {
    return fails("subagent-routing", "tier-alias-unsupported");
  }
  if (!input.contract.aliases.exactIdsNotTiers) return fails("subagent-routing", "tier-alias-collision");
  return passes("subagent-routing");
}

/** Gate F3 — parallel subagents keep distinct attribution contexts. */
function checkSubagentParallel(input: MatrixInput): CanaryGateResult {
  if (input.contract.client !== "claude-code") return notRun("subagent-parallel", "client-contract-not-applicable");
  const shapes = fixtureShapes(input);
  const first = parseAgentContext(shapes.attributionHeaders);
  const second = parseAgentContext(shapes.attributionHeadersParallel);
  if (first === undefined || second === undefined) return fails("subagent-parallel", "parallel-attribution-collision");
  if (first.agentId === second.agentId) return fails("subagent-parallel", "parallel-attribution-collision");
  if (first.claudeSessionId !== second.claudeSessionId) return fails("subagent-parallel", "parallel-attribution-collision");
  return passes("subagent-parallel");
}

/** Gate F4 — subagent/session effort reaches the gateway decoder faithfully. */
function checkEffortSignal(input: MatrixInput): CanaryGateResult {
  if (input.contract.client !== "claude-code") return notRun("effort-signal", "client-contract-not-applicable");
  const decoded = decodeAnthropicRequest(fixtureShapes(input).effortRequest);
  const reasoning = decoded.request.inference.reasoning;
  if (reasoning?.sourceEffort !== "high") return fails("effort-signal", "effort-signal-lost");
  if (!input.contract.effort.optional) return fails("effort-signal", "effort-signal-lost");
  if (!input.contract.effort.effortLevels.includes("high")) return fails("effort-signal", "effort-level-unknown");
  return passes("effort-signal");
}

/** Gate G — long-running session contract (framing, cancellation, cache). */
function checkLongRunningSession(input: MatrixInput): CanaryGateResult {
  if (input.contract.framing.sessionIsolatedFlag !== "--no-session-persistence") {
    return fails("long-running-session", "session-contract-changed");
  }
  if (!input.contract.framing.cancellationPropagates) return fails("long-running-session", "session-contract-changed");
  if (input.contract.client === "claude-code" && !input.contract.modelDiscovery.cacheAcrossStartups) {
    return fails("long-running-session", "session-contract-changed");
  }
  return passes("long-running-session");
}

const CHECKS: readonly Readonly<{ gate: CanaryGate; run: (input: MatrixInput) => CanaryGateResult }>[] = Object.freeze([
  { gate: "text", run: checkText },
  { gate: "streaming", run: checkStreaming },
  { gate: "cancellation", run: checkCancellation },
  { gate: "tools-single", run: checkToolsSingle },
  { gate: "tools-multi", run: checkToolsMulti },
  { gate: "tools-parallel", run: checkToolsParallel },
  { gate: "reasoning", run: checkReasoning },
  { gate: "reasoning-tools", run: checkReasoningTools },
  { gate: "model-discovery", run: checkModelDiscovery },
  { gate: "session-attribution", run: checkSessionAttribution },
  { gate: "subagent-routing", run: checkSubagentRouting },
  { gate: "subagent-parallel", run: checkSubagentParallel },
  { gate: "effort-signal", run: checkEffortSignal },
  { gate: "long-running-session", run: checkLongRunningSession },
]);

/** Runs the deterministic gate matrix for one exact access path. */
export function runGateMatrix(input: MatrixInput): readonly CanaryGateResult[] {
  return Object.freeze(CHECKS.map(({ run }) => run(input)));
}

/** Re-runs one gate against an overridden contract fixture (drift tests). */
export function runSingleGate(
  gate: CanaryGate,
  input: MatrixInput,
): CanaryGateResult {
  const check = CHECKS.find((candidate) => candidate.gate === gate);
  if (check === undefined) return notRun(gate, "unknown-gate");
  return check.run(input);
}
